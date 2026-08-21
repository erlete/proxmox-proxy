import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { pipeline } from 'node:stream'
import type { Dispatcher } from 'undici'
import { authorize, classify, type Classified } from '../admission/classify.js'
import {
  Admission,
  ClientGoneError,
  HoldTimeoutError,
  QueueFullError,
  type Grant,
} from '../admission/queue.js'
import type { Config } from '../config.js'
import { parseAuthorization } from '../keys/auth.js'
import { vmidAllowed, type ApiKeyRecord, type KeyStore } from '../keys/store.js'
import { log } from '../log.js'
import type { OpsLog } from '../ops.js'
import type { HealthMonitor } from '../upstream/health.js'
import type { Upstream } from '../upstream/client.js'

export interface DataPlaneDeps {
  config: Config
  keys: KeyStore
  upstream: Upstream
  admission: Admission
  health: HealthMonitor
  singletonHeld: () => boolean
  ops: OpsLog
}

const REQ_STRIP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'authorization',
])

const RESP_STRIP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'trailer'])

const MAX_HEAVY_BODY = 1024 * 1024

class PayloadTooLargeError extends Error {}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': buf.length })
  res.end(buf)
}

function fwdHeaders(
  req: IncomingMessage,
  serviceAuth: string,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || REQ_STRIP.has(k)) continue
    out[k] = v
  }
  out['authorization'] = serviceAuth
  return out
}

function respHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || RESP_STRIP.has(k.toLowerCase())) continue
    out[k] = v
  }
  return out
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        reject(new PayloadTooLargeError())
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function extractNewid(body: Buffer, contentType: string | undefined): number | null {
  try {
    let raw: unknown
    if (contentType?.includes('application/json')) {
      raw = (JSON.parse(body.toString()) as Record<string, unknown>).newid
    } else {
      raw = new URLSearchParams(body.toString()).get('newid')
    }
    if (raw == null) return null
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10)
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

export function createDataPlane(deps: DataPlaneDeps): Server {
  const { config, keys, upstream, admission, health, ops } = deps
  const serviceAuth = `PVEAPIToken=${config.serviceToken}`

  const healthBody = (): Record<string, unknown> => ({
    status: health.state.ok && deps.singletonHeld() ? 'ok' : 'degraded',
    upstream: { ok: health.state.ok, version: health.state.version, checkedAt: health.state.checkedAt },
    singleton: { enabled: !config.singleton.disabled, held: deps.singletonHeld() },
  })

  async function handleHeavy(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    cls: Classified,
    key: ApiKeyRecord,
    started: number,
  ): Promise<void> {
    const method = req.method as Dispatcher.HttpMethod
    const base = {
      keyName: key.name,
      method: req.method ?? '',
      path: url.pathname,
      opClass: cls.opClass,
      vmid: cls.pathVmid,
    }

    let body: Buffer
    try {
      body = await readBody(req, MAX_HEAVY_BODY)
    } catch (err) {
      if (err instanceof PayloadTooLargeError) {
        sendJson(res, 413, { message: 'request body too large' })
        return
      }
      return // client went away mid-body
    }

    // A clone names its target in the body: that VMID must also be in range.
    if (cls.opClass === 'clone') {
      const newid = extractNewid(body, req.headers['content-type'])
      if (newid == null) {
        sendJson(res, 400, { message: 'clone through the proxy requires an explicit newid' })
        return
      }
      if (!vmidAllowed(key.vmidRanges, newid)) {
        sendJson(res, 403, { message: `newid ${newid} is outside the ranges of this key` })
        ops.record({ ...base, status: 403, queueMs: null, durationMs: null, upid: null, note: 'denied-newid' })
        return
      }
    }

    const abort = new AbortController()
    let settled = false
    res.on('close', () => {
      if (!settled) abort.abort()
    })

    let grant: Grant
    try {
      grant = await admission.acquire(
        { opClass: cls.opClass!, keyName: key.name, vmid: cls.pathVmid, node: cls.node },
        abort.signal,
      )
    } catch (err) {
      settled = true
      if (err instanceof QueueFullError || err instanceof HoldTimeoutError) {
        const note = err instanceof QueueFullError ? 'queue-full' : 'hold-timeout'
        res.setHeader('retry-after', String(err.retryAfterSec))
        sendJson(res, 429, { message: `cluster busy, retry in ${err.retryAfterSec}s` })
        ops.record({ ...base, status: 429, queueMs: Date.now() - started, durationMs: null, upid: null, note })
      } else if (err instanceof ClientGoneError) {
        ops.record({ ...base, status: null, queueMs: Date.now() - started, durationMs: null, upid: null, note: 'client-gone' })
      } else {
        sendJson(res, 500, { message: 'internal proxy error' })
        log.error('admission failure', { error: String(err) })
      }
      return
    }

    try {
      const headers = fwdHeaders(req, serviceAuth)
      delete headers['accept-encoding'] // response must stay parseable for the UPID
      headers['content-length'] = String(body.length)
      const r = await upstream.raw({ method, path: url.pathname + url.search, headers, body })
      const respBuf = Buffer.from(await r.body.arrayBuffer())

      let upid: string | null = null
      if (r.statusCode < 400) {
        try {
          const parsed = JSON.parse(respBuf.toString()) as { data?: unknown }
          if (typeof parsed.data === 'string' && parsed.data.startsWith('UPID:')) upid = parsed.data
        } catch {
          // not JSON: no task to track
        }
      }
      if (upid) grant.attachTask(upid)
      else grant.release(r.statusCode < 400 ? 'no-task' : `upstream-${r.statusCode}`)

      ops.record({
        ...base,
        status: r.statusCode,
        queueMs: grant.queueMs,
        durationMs: Date.now() - started,
        upid,
        note: upid ? 'running' : null,
      })

      settled = true
      const out = respHeaders(r.headers)
      out['content-length'] = String(respBuf.length)
      res.writeHead(r.statusCode, out)
      res.end(respBuf)
    } catch (err) {
      grant.release('upstream-error')
      settled = true
      sendJson(res, 502, { message: 'upstream unavailable' })
      ops.record({ ...base, status: 502, queueMs: grant.queueMs, durationMs: Date.now() - started, upid: null, note: 'upstream-error' })
      log.warn('heavy op forward failed', { path: url.pathname, error: String(err) })
    }
  }

  async function handlePass(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    cls: Classified,
    key: ApiKeyRecord,
    started: number,
  ): Promise<void> {
    const method = req.method as Dispatcher.HttpMethod
    const hasBody = method !== 'GET' && method !== 'HEAD'
    try {
      const r = await upstream.raw({
        method,
        path: url.pathname + url.search,
        headers: fwdHeaders(req, serviceAuth),
        body: hasBody ? req : undefined,
      })
      if (method !== 'GET' || r.statusCode >= 400) {
        ops.record({
          keyName: key.name,
          method: req.method ?? '',
          path: url.pathname,
          opClass: null,
          vmid: cls.pathVmid ?? cls.upidVmid,
          status: r.statusCode,
          queueMs: null,
          durationMs: Date.now() - started,
          upid: null,
          note: null,
        })
      }
      res.writeHead(r.statusCode, respHeaders(r.headers))
      pipeline(r.body, res, () => {})
    } catch (err) {
      sendJson(res, 502, { message: 'upstream unavailable' })
      log.warn('passthrough failed', { path: url.pathname, error: String(err) })
    }
  }

  const server = createServer((req, res) => {
    void (async () => {
      const started = Date.now()
      const url = new URL(req.url ?? '/', 'http://internal')

      if (url.pathname === '/proxy/health') {
        sendJson(res, 200, healthBody())
        return
      }

      if (!url.pathname.startsWith('/api2/') && url.pathname !== '/proxy/whoami') {
        sendJson(res, 404, { message: 'not found' })
        return
      }

      const parsed = parseAuthorization(req.headers.authorization)
      const key = parsed && keys.verify(parsed.tokenUser, parsed.name, parsed.secret)
      if (!key) {
        sendJson(res, 401, { message: 'authentication failure' })
        return
      }

      if (url.pathname === '/proxy/whoami') {
        sendJson(res, 200, {
          name: key.name,
          vmidRanges: key.vmidRanges,
          websocketBase: config.publicWsUrl,
          admission: config.admission.caps,
        })
        return
      }

      if (req.headers.upgrade) {
        sendJson(res, 501, {
          message: 'websockets are not proxied; connect to the cluster node directly',
        })
        return
      }

      const cls = classify(req.method ?? 'GET', url.pathname)
      const denied = authorize(req.method ?? 'GET', cls, (vmid) => vmidAllowed(key.vmidRanges, vmid))
      if (denied) {
        sendJson(res, 403, { message: denied })
        ops.record({
          keyName: key.name,
          method: req.method ?? '',
          path: url.pathname,
          opClass: cls.opClass,
          vmid: cls.pathVmid ?? cls.upidVmid,
          status: 403,
          queueMs: null,
          durationMs: null,
          upid: null,
          note: 'denied',
        })
        return
      }

      if (cls.opClass) await handleHeavy(req, res, url, cls, key, started)
      else await handlePass(req, res, url, cls, key, started)
    })().catch((err) => {
      log.error('data plane handler crash', { error: String(err) })
      sendJson(res, 500, { message: 'internal proxy error' })
    })
  })

  return server
}
