/**
 * Stream-impact probe: characterize how cluster operations affect a LIVE noVNC
 * stream served by the same node.
 *
 * Motivation: the product premise is stream quality first. A destroy must never
 * freeze a viewer's console, yet that is exactly what was observed in the field
 * (a box teardown froze every spectator on the node). Before mitigating, this
 * harness measures the real effect of each operation class, alone and in
 * bursts, on a real RFB stream.
 *
 * What it does:
 *  1. Clones a template into a PROBE VM (outside every app range), starts it,
 *     and opens a real VNC websocket to it (vncproxy -> vncwebsocket, full RFB
 *     handshake with DES VNC auth), exactly the path a browser viewer uses.
 *  2. Continuously requests small non-incremental framebuffer updates and
 *     timestamps every response: request->frame latency is what a viewer feels.
 *     In parallel it measures WS ping RTT (pveproxy/network path) and a trivial
 *     API GET (control plane), to tell WHICH layer degrades.
 *  3. Runs marked operation phases against SCRATCH VMs (never the probe):
 *     clone x1, clone x2, start, stop, suspend-to-disk, destroy x1, destroy x2,
 *     mixed clone+destroy. Settle time between phases.
 *  4. Tears everything down and writes a JSON with the full time series plus a
 *     per-phase summary (p50/p95/max, stalls) to PROBE_OUT (or CWD).
 *
 * Required env: PROBE_URL, PROBE_USERNAME, PROBE_PASSWORD, PROBE_NODE,
 * PROBE_TEMPLATE. Optional: PROBE_BASE_VMID (default 1900100), PROBE_OUT.
 * TLS verification is disabled: the target is a lab cluster on a bare IP.
 */
import { createCipheriv } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { Agent, setGlobalDispatcher } from 'undici'
import WebSocket from 'ws'

setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false, timeout: 20_000 } }))

/**
 * The lab cluster sits on a public IP and the path to it flaps now and then. A
 * connect timeout means the request NEVER reached the server, so retrying is
 * safe even for POSTs; anything that got as far as headers is not retried.
 */
async function fetchRetry(url: string, init: RequestInit): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, init)
    } catch (err) {
      const cause = (err as { cause?: { code?: string } }).cause
      if (attempt >= 4 || cause?.code !== 'UND_ERR_CONNECT_TIMEOUT') throw err
      console.log(`  (connect timeout, retry ${attempt})`)
      await sleep(2000)
    }
  }
}

const URL_BASE = process.env.PROBE_URL ?? ''
const USERNAME = process.env.PROBE_USERNAME ?? 'root@pam'
const PASSWORD = process.env.PROBE_PASSWORD ?? ''
const NODE = process.env.PROBE_NODE ?? ''
const TEMPLATE = Number.parseInt(process.env.PROBE_TEMPLATE ?? '', 10)
const BASE = Number.parseInt(process.env.PROBE_BASE_VMID ?? '1900100', 10)
const OUT = process.env.PROBE_OUT ?? 'probe-stream-results.json'
/** Backup storage for the vzdump positive-control phase; empty skips it. */
const BACKUP_STORAGE = process.env.PROBE_BACKUP_STORAGE ?? ''
if (!URL_BASE || !PASSWORD || !NODE || !(TEMPLATE > 0)) {
  console.error('set PROBE_URL, PROBE_PASSWORD, PROBE_NODE, PROBE_TEMPLATE')
  process.exit(1)
}

const PROBE_VMID = BASE
let nextScratch = BASE + 1
const scratch = (): number => nextScratch++

// ---------------------------------------------------------------- API client
let ticket = ''
let csrf = ''

async function login(): Promise<void> {
  const res = await fetch(`${URL_BASE}/api2/json/access/ticket`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: USERNAME, password: PASSWORD }).toString(),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  const data = (await res.json()) as {
    data: { ticket: string; CSRFPreventionToken: string }
  }
  ticket = data.data.ticket
  csrf = data.data.CSRFPreventionToken
}

async function api<T = unknown>(
  method: string,
  path: string,
  body?: Record<string, string | number>,
): Promise<T> {
  const headers: Record<string, string> = { cookie: `PVEAuthCookie=${ticket}` }
  let bodyStr: string | undefined
  if (method !== 'GET') headers.csrfpreventiontoken = csrf
  if (body) {
    headers['content-type'] = 'application/x-www-form-urlencoded'
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(body)) p.append(k, String(v))
    bodyStr = p.toString()
  }
  const res = await fetchRetry(`${URL_BASE}/api2/json${path}`, { method, headers, body: bodyStr })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`)
  return (JSON.parse(text) as { data: T }).data
}

async function waitTask(upid: string): Promise<void> {
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    const st = await api<{ status: string; exitstatus?: string }>(
      'GET',
      `/nodes/${NODE}/tasks/${encodeURIComponent(upid)}/status`,
    )
    if (st.status === 'stopped') {
      if (st.exitstatus !== 'OK') throw new Error(`task ${upid} -> ${st.exitstatus}`)
      return
    }
    await sleep(500)
  }
  throw new Error(`task timeout: ${upid}`)
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------- samples
type Sample = { t: number; kind: 'frame' | 'ping' | 'api'; ms: number; bytes?: number }
type Phase = { name: string; start: number; end: number }
type EventRow = { t: number; what: string }
const samples: Sample[] = []
const phases: Phase[] = []
const events: EventRow[] = []
const t0 = Date.now()
const now = (): number => Date.now() - t0
const mark = (what: string): void => {
  events.push({ t: now(), what })
  console.log(`  [${(now() / 1000).toFixed(1)}s] ${what}`)
}

// -------------------------------------------------------------- RFB stream
/** VNC auth DES: key = first 8 password bytes, each byte bit-reversed. */
function vncAuthResponse(challenge: Buffer, password: string): Buffer {
  const key = Buffer.alloc(8)
  for (let i = 0; i < 8; i++) {
    let b = i < password.length ? password.charCodeAt(i) & 0xff : 0
    b = ((b & 0xf0) >> 4) | ((b & 0x0f) << 4)
    b = ((b & 0xcc) >> 2) | ((b & 0x33) << 2)
    b = ((b & 0xaa) >> 1) | ((b & 0x55) << 1)
    key[i] = b
  }
  const cipher = createCipheriv('des-ecb', key, null)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(challenge), cipher.final()])
}

/** Buffered async reader over WS binary messages. */
class WsReader {
  private chunks: Buffer[] = []
  private buffered = 0
  private waiter: (() => void) | null = null
  closed = false

  constructor(ws: WebSocket) {
    ws.on('message', (data: Buffer) => {
      this.chunks.push(data)
      this.buffered += data.length
      this.waiter?.()
    })
    ws.on('close', () => {
      this.closed = true
      this.waiter?.()
    })
    ws.on('error', () => {
      this.closed = true
      this.waiter?.()
    })
  }

  async read(n: number): Promise<Buffer> {
    while (this.buffered < n) {
      if (this.closed) throw new Error('stream closed')
      await new Promise<void>((r) => {
        this.waiter = r
      })
      this.waiter = null
    }
    const out = Buffer.alloc(n)
    let off = 0
    while (off < n) {
      const head = this.chunks[0]
      const take = Math.min(head.length, n - off)
      head.copy(out, off, 0, take)
      off += take
      if (take === head.length) this.chunks.shift()
      else this.chunks[0] = head.subarray(take)
    }
    this.buffered -= n
    return out
  }
}

interface Stream {
  ws: WebSocket
  reader: WsReader
  bytesPerPixel: number
  width: number
  height: number
}

async function openStream(vmid: number): Promise<Stream> {
  const vnc = await api<{ port: string | number; ticket: string }>(
    'POST',
    `/nodes/${NODE}/qemu/${vmid}/vncproxy`,
    { websocket: 1 },
  )
  const wsUrl =
    `${URL_BASE.replace('https:', 'wss:')}/api2/json/nodes/${NODE}/qemu/${vmid}/vncwebsocket` +
    `?port=${vnc.port}&vncticket=${encodeURIComponent(vnc.ticket)}`
  const ws = new WebSocket(wsUrl, ['binary'], {
    rejectUnauthorized: false,
    headers: { cookie: `PVEAuthCookie=${encodeURIComponent(ticket)}` },
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const reader = new WsReader(ws)

  // RFB version handshake.
  const serverVersion = await reader.read(12)
  ws.send(Buffer.from('RFB 003.008\n'))
  // Security: pick VNC auth (2) from the offered list.
  const nTypes = (await reader.read(1))[0]
  if (nTypes === 0) throw new Error('server refused RFB connection')
  const types = await reader.read(nTypes)
  if (!types.includes(2)) throw new Error(`VNC auth not offered (types=${[...types]})`)
  ws.send(Buffer.from([2]))
  const challenge = await reader.read(16)
  ws.send(vncAuthResponse(challenge, vnc.ticket))
  const result = (await reader.read(4)).readUInt32BE(0)
  if (result !== 0) throw new Error('VNC auth failed')
  // ClientInit (shared) -> ServerInit.
  ws.send(Buffer.from([1]))
  const init = await reader.read(24)
  const width = init.readUInt16BE(0)
  const height = init.readUInt16BE(2)
  const bitsPerPixel = init[4]
  const nameLen = init.readUInt32BE(20)
  await reader.read(nameLen)
  // SetEncodings: Raw only, so every rectangle is trivially parseable.
  const enc = Buffer.alloc(8)
  enc[0] = 2
  enc.writeUInt16BE(1, 2)
  enc.writeInt32BE(0, 4)
  ws.send(enc)
  console.log(
    `  stream open: ${serverVersion.toString().trim()} ${width}x${height}@${bitsPerPixel}bpp`,
  )
  return { ws, reader, bytesPerPixel: bitsPerPixel / 8, width, height }
}

/** Request one non-incremental update of a small rect and consume the reply. */
async function frameOnce(s: Stream, w: number, h: number): Promise<number> {
  const req = Buffer.alloc(10)
  req[0] = 3
  req[1] = 0 // non-incremental: the server must resend the region
  req.writeUInt16BE(0, 2)
  req.writeUInt16BE(0, 4)
  req.writeUInt16BE(Math.min(w, s.width), 6)
  req.writeUInt16BE(Math.min(h, s.height), 8)
  const started = Date.now()
  s.ws.send(req)
  // Consume server messages until one FramebufferUpdate is fully read.
  for (;;) {
    const type = (await s.reader.read(1))[0]
    if (type === 0) {
      const head = await s.reader.read(3)
      const nRects = head.readUInt16BE(1)
      let bytes = 0
      for (let i = 0; i < nRects; i++) {
        const r = await s.reader.read(12)
        const rw = r.readUInt16BE(4)
        const rh = r.readUInt16BE(6)
        const encoding = r.readInt32BE(8)
        if (encoding !== 0) throw new Error(`unexpected encoding ${encoding}`)
        const n = rw * rh * s.bytesPerPixel
        await s.reader.read(n)
        bytes += n
      }
      const ms = Date.now() - started
      samples.push({ t: now(), kind: 'frame', ms, bytes })
      return ms
    } else if (type === 1) {
      const h2 = await s.reader.read(5)
      await s.reader.read(h2.readUInt16BE(3) * 6)
    } else if (type === 2) {
      // Bell: nothing to consume.
    } else if (type === 3) {
      const h3 = await s.reader.read(7)
      await s.reader.read(h3.readUInt32BE(3))
    } else {
      throw new Error(`unknown server message ${type}`)
    }
  }
}

// ----------------------------------------------------------------- ops
const cloneOne = async (newid: number, name: string, full = 0): Promise<void> =>
  waitTask(
    await api<string>('POST', `/nodes/${NODE}/qemu/${TEMPLATE}/clone`, { newid, name, full }),
  )
const startOne = async (vmid: number): Promise<void> =>
  waitTask(await api<string>('POST', `/nodes/${NODE}/qemu/${vmid}/status/start`))
const stopOne = async (vmid: number): Promise<void> =>
  waitTask(await api<string>('POST', `/nodes/${NODE}/qemu/${vmid}/status/stop`))
const suspendOne = async (vmid: number): Promise<void> =>
  waitTask(await api<string>('POST', `/nodes/${NODE}/qemu/${vmid}/status/suspend`, { todisk: 1 }))
const destroyOne = async (vmid: number): Promise<void> =>
  waitTask(
    await api<string>('DELETE', `/nodes/${NODE}/qemu/${vmid}?purge=1&destroy-unreferenced-disks=1`),
  )

async function phase(name: string, run: () => Promise<void>): Promise<void> {
  mark(`phase ${name}: start`)
  const start = now()
  await run()
  const end = now()
  phases.push({ name, start, end })
  mark(`phase ${name}: end (${((end - start) / 1000).toFixed(1)}s)`)
}

// --------------------------------------------------------------- summary
function pct(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

function summarize(): void {
  console.log('\n=== per-phase summary (frame latency ms) ===')
  console.log(
    'phase'.padEnd(22) +
      'n'.padStart(6) +
      'p50'.padStart(8) +
      'p95'.padStart(8) +
      'max'.padStart(8) +
      '>300ms'.padStart(8) +
      '>1s'.padStart(6) +
      'ping p95'.padStart(10) +
      'api p95'.padStart(9),
  )
  for (const ph of phases) {
    const inPhase = (s: Sample): boolean => s.t >= ph.start && s.t <= ph.end
    const frames = samples.filter((s) => s.kind === 'frame' && inPhase(s)).map((s) => s.ms)
    const pings = samples.filter((s) => s.kind === 'ping' && inPhase(s)).map((s) => s.ms)
    const apis = samples.filter((s) => s.kind === 'api' && inPhase(s)).map((s) => s.ms)
    console.log(
      ph.name.padEnd(22) +
        String(frames.length).padStart(6) +
        String(pct(frames, 50)).padStart(8) +
        String(pct(frames, 95)).padStart(8) +
        String(frames.length ? Math.max(...frames) : 0).padStart(8) +
        String(frames.filter((v) => v > 300).length).padStart(8) +
        String(frames.filter((v) => v > 1000).length).padStart(6) +
        String(pct(pings, 95)).padStart(10) +
        String(pct(apis, 95)).padStart(9),
    )
  }
}

// ------------------------------------------------------------------ main
const created = new Set<number>()

async function main(): Promise<void> {
  await login()
  console.log('logged in as', USERNAME)

  // Refuse to run if the probe band is not free.
  const resources = await api<{ vmid?: number; type: string }[]>('GET', '/cluster/resources')
  const used = new Set(
    resources.filter((r) => r.type === 'qemu' && r.vmid != null).map((r) => r.vmid as number),
  )
  for (let v = BASE; v < BASE + 100; v++) {
    if (used.has(v)) throw new Error(`probe band not free: vmid ${v} exists`)
  }
  if (!used.has(TEMPLATE)) throw new Error(`template ${TEMPLATE} not found`)

  mark(`setup: clone template ${TEMPLATE} -> probe ${PROBE_VMID}`)
  await cloneOne(PROBE_VMID, 'pp-probe-stream')
  created.add(PROBE_VMID)
  await startOne(PROBE_VMID)
  mark('setup: probe running, waiting 15s for the framebuffer to settle')
  await sleep(15_000)

  let stream = await openStream(PROBE_VMID)
  stream.ws.on('close', () => mark('STREAM DISCONNECTED'))

  // Continuous probes. Frame loop: back-to-back with a small floor (<=20 Hz).
  // If the websocket dies (path flap), reopen a fresh console session and keep
  // measuring; the DISCONNECTED/reconnect marks land in the event log as data.
  let running = true
  const frameLoop = (async () => {
    while (running) {
      try {
        const ms = await frameOnce(stream, 64, 64)
        await sleep(Math.max(0, 50 - ms))
      } catch (err) {
        if (!running) break
        mark(`frame loop error: ${String(err)}`)
        if (stream.reader.closed) {
          try {
            stream = await openStream(PROBE_VMID)
            stream.ws.on('close', () => mark('STREAM DISCONNECTED'))
            mark('stream reconnected')
          } catch (re) {
            mark(`stream reconnect failed: ${String(re)}`)
          }
        }
        await sleep(1000)
      }
    }
  })()
  const pingLoop = (async () => {
    while (running) {
      const started = Date.now()
      const acked = new Promise<void>((r) => stream.ws.once('pong', () => r()))
      try {
        stream.ws.ping()
        await Promise.race([acked, sleep(5000)])
        samples.push({ t: now(), kind: 'ping', ms: Date.now() - started })
      } catch {
        /* socket gone; the close handler reports it */
      }
      await sleep(1000)
    }
  })()
  const apiLoop = (async () => {
    while (running) {
      const started = Date.now()
      try {
        await api('GET', '/version')
        samples.push({ t: now(), kind: 'api', ms: Date.now() - started })
      } catch {
        samples.push({ t: now(), kind: 'api', ms: Date.now() - started })
      }
      await sleep(500)
    }
  })()

  const settle = async (): Promise<void> => {
    await phase('settle', () => sleep(8_000))
  }

  // ---- the experiment matrix ----
  // Quantities scale x1 -> x2 -> x4 per class, because the question is not
  // just "does a destroy hurt" but "at what volume does it start to".
  const cloneBatch = async (n: number, full = 0): Promise<number[]> => {
    const ids = Array.from({ length: n }, () => scratch())
    await Promise.all(
      ids.map((id) =>
        cloneOne(id, `pp-scratch${full ? '-full' : ''}-${id}`, full).then(() => {
          created.add(id)
        }),
      ),
    )
    return ids
  }
  const destroyBatch = async (ids: number[]): Promise<void> => {
    await Promise.all(
      ids.map((id) =>
        destroyOne(id).then(() => {
          created.delete(id)
        }),
      ),
    )
  }

  await phase('baseline', () => sleep(20_000))

  // Focused threshold mode: bracket the concurrency at which clone/destroy
  // bursts start to stall the stream (round 2 saw x2 clean and x4 freeze 5.5s).
  if (process.env.PROBE_MATRIX === 'threshold') {
    for (const n of [3, 4, 6]) {
      let ids: number[] = []
      await phase(`clone-x${n}`, async () => {
        ids = await cloneBatch(n)
      })
      await settle()
      await phase(`destroy-x${n}`, () => destroyBatch(ids))
      await settle()
    }
    await phase('cooldown', () => sleep(10_000))
    running = false
    stream.ws.close()
    await Promise.allSettled([frameLoop, pingLoop, apiLoop])
    summarize()
    writeFileSync(OUT, JSON.stringify({ t0, phases, events, samples }, null, 1))
    console.log(`\nresults written to ${OUT} (${samples.length} samples)`)
    return
  }

  let l1: number[] = []
  let l2: number[] = []
  let l4: number[] = []
  await phase('clone-x1', async () => {
    l1 = await cloneBatch(1)
  })
  await settle()
  await phase('clone-x2', async () => {
    l2 = await cloneBatch(2)
  })
  await settle()
  await phase('clone-x4', async () => {
    l4 = await cloneBatch(4)
  })
  await settle()

  const runningSet = [l1[0], l2[0], l2[1], l4[0]]
  await phase('start-x4', async () => {
    await Promise.all(runningSet.map(startOne))
  })
  await settle()
  await phase('suspend-x1', () => suspendOne(l1[0]))
  await settle()
  await phase('stop-x3', async () => {
    await Promise.all([l2[0], l2[1], l4[0]].map(stopOne))
  })
  await settle()

  await phase('destroy-x1', () => destroyBatch(l1))
  await settle()
  await phase('destroy-x2', () => destroyBatch(l2))
  await settle()
  await phase('destroy-x4', () => destroyBatch(l4))
  await settle()

  // Full clones: write the whole disk (not a COW snapshot), and their destroy
  // removes a REAL volume. The heaviest routine I/O the cluster sees and the
  // closest analogue to a loaded teardown, so measure both at x1 and x2.
  let f1: number[] = []
  let f2: number[] = []
  await phase('clone-full-x1', async () => {
    f1 = await cloneBatch(1, 1)
  })
  await settle()
  await phase('clone-full-x2', async () => {
    f2 = await cloneBatch(2, 1)
  })
  await settle()
  await phase('destroy-full-x1', () => destroyBatch(f1))
  await settle()
  await phase('destroy-full-x2', () => destroyBatch(f2))
  await settle()

  // vzdump of the RUNNING probe VM: the positive control. A live backup reads
  // the disk end to end and writes the archive back to the same pool; it is
  // the canonical I/O hog on a PVE node. If any operation can degrade the
  // stream, this one must show it, which validates the instrument; and it
  // doubles as the "scheduled backup during an event" scenario.
  if (BACKUP_STORAGE) {
    await phase('vzdump-x1', async () => {
      await waitTask(
        await api<string>('POST', `/nodes/${NODE}/vzdump`, {
          vmid: PROBE_VMID,
          storage: BACKUP_STORAGE,
          mode: 'snapshot',
          compress: 'zstd',
          remove: 0,
        }),
      )
    })
    try {
      const content = await api<{ volid: string }[]>(
        'GET',
        `/nodes/${NODE}/storage/${BACKUP_STORAGE}/content?content=backup&vmid=${PROBE_VMID}`,
      )
      for (const c of content) {
        await api(
          'DELETE',
          `/nodes/${NODE}/storage/${BACKUP_STORAGE}/content/${encodeURIComponent(c.volid)}`,
        )
        mark(`backup ${c.volid} deleted`)
      }
    } catch (err) {
      mark(`backup cleanup failed: ${String(err)}`)
    }
    await settle()
  }

  let m12: number[] = []
  let m3: number[] = []
  await phase('clone-x2-prep', async () => {
    m12 = await cloneBatch(2)
  })
  await settle()
  await phase('mixed-clone+destroy', async () => {
    await Promise.all([
      cloneBatch(1).then((ids) => {
        m3 = ids
      }),
      destroyBatch(m12),
    ])
  })
  await settle()
  await phase('destroy-x1-tail', () => destroyBatch(m3))
  await phase('cooldown', () => sleep(10_000))

  running = false
  stream.ws.close()
  await Promise.allSettled([frameLoop, pingLoop, apiLoop])

  summarize()
  writeFileSync(OUT, JSON.stringify({ t0, phases, events, samples }, null, 1))
  console.log(`\nresults written to ${OUT} (${samples.length} samples)`)
}

async function teardown(): Promise<void> {
  for (const vmid of [...created]) {
    try {
      const st = await api<{ status: string }>('GET', `/nodes/${NODE}/qemu/${vmid}/status/current`)
      if (st.status === 'running') await stopOne(vmid)
      await destroyOne(vmid)
      console.log(`teardown: destroyed ${vmid}`)
    } catch (err) {
      console.error(`teardown: could not destroy ${vmid}: ${String(err)}`)
    }
  }
}

try {
  await main()
} finally {
  await teardown()
}
