import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
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
import type { SettingsStore } from '../settings.js'
import { ConsoleDisabledError, type ConsoleBroker } from '../upstream/console.js'
import type { HealthMonitor } from '../upstream/health.js'
import { UpstreamError, type Upstream } from '../upstream/client.js'

export interface DataPlaneDeps {
  config: Config
  keys: KeyStore
  settings: SettingsStore
  upstream: Upstream
  admission: Admission
  health: HealthMonitor
  console: ConsoleBroker
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

function fwdHeaders(req: IncomingMessage, serviceAuth: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || REQ_STRIP.has(k)) continue
    out[k] = v
  }
  out['authorization'] = serviceAuth
  return out
}

function respHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
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

/** Read a target VMID named in the request body (clone `newid`, move
 * `target-vmid`), from either a JSON or a form-encoded body. */
function extractBodyVmid(
  body: Buffer,
  contentType: string | undefined,
  param: string,
): number | null {
  try {
    let raw: unknown
    if (contentType?.includes('application/json')) {
      raw = (JSON.parse(body.toString()) as Record<string, unknown>)[param]
    } else {
      raw = new URLSearchParams(body.toString()).get(param)
    }
    if (raw == null) return null
    const n = typeof raw === 'number' ? raw : Number.parseInt(String(raw), 10)
    return Number.isInteger(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

/**
 * The data-plane request handler. Mounted by the app under a single edge server
 * that routes `/api2/*` and `/proxy/*` here; there is no separate listener.
 */
export function createDataPlaneHandler(deps: DataPlaneDeps): RequestListener {
  const { config, keys, settings, upstream, admission, health, console: consoleBroker, ops } = deps
  const serviceAuth = `PVEAPIToken=${config.serviceToken}`

  const healthBody = (): Record<string, unknown> => ({
    status: health.state.ok && deps.singletonHeld() ? 'ok' : 'degraded',
    upstream: {
      ok: health.state.ok,
      version: health.state.version,
      checkedAt: health.state.checkedAt,
    },
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
      const newid = extractBodyVmid(body, req.headers['content-type'], 'newid')
      if (newid == null) {
        sendJson(res, 400, { message: 'clone through the proxy requires an explicit newid' })
        return
      }
      if (vmidAllowed(settings.reservedRanges, newid)) {
        sendJson(res, 403, { message: `newid ${newid} is reserved` })
        ops.record({
          ...base,
          status: 403,
          queueMs: null,
          durationMs: null,
          upid: null,
          note: 'reserved-newid',
        })
        return
      }
      if (!vmidAllowed(key.vmidRanges, newid)) {
        sendJson(res, 403, { message: `newid ${newid} is outside the ranges of this key` })
        ops.record({
          ...base,
          status: 403,
          queueMs: null,
          durationMs: null,
          upid: null,
          note: 'denied-newid',
        })
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
        ops.record({
          ...base,
          status: 429,
          queueMs: Date.now() - started,
          durationMs: null,
          upid: null,
          note,
        })
      } else if (err instanceof ClientGoneError) {
        ops.record({
          ...base,
          status: null,
          queueMs: Date.now() - started,
          durationMs: null,
          upid: null,
          note: 'client-gone',
        })
      } else {
        // Fail-closed: an internal admission failure must NEVER fall through to
        // the cluster. Refuse (retryable) and record it; the operation did not
        // run. Forwarding on internal error would defeat the whole point of
        // admission, so we bias to a visible refusal over uncontrolled load.
        res.setHeader('retry-after', '5')
        sendJson(res, 503, { message: 'admission unavailable, retry shortly' })
        ops.record({
          ...base,
          status: 503,
          queueMs: Date.now() - started,
          durationMs: null,
          upid: null,
          note: 'admission-error',
        })
        log.error('admission failed closed', { error: String(err) })
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
      ops.record({
        ...base,
        status: 502,
        queueMs: grant.queueMs,
        durationMs: Date.now() - started,
        upid: null,
        note: 'upstream-error',
      })
      log.warn('heavy op forward failed', { path: url.pathname, error: String(err) })
    }
  }

  /**
   * Native endpoint: mints VNC console credentials for an in-scope VM so the
   * app can open the websocket DIRECTLY against the cluster node (streams
   * never cross the proxy) without holding any Proxmox credential itself.
   */
  async function handleConsoleSession(
    req: IncomingMessage,
    res: ServerResponse,
    key: ApiKeyRecord,
  ): Promise<void> {
    const started = Date.now()
    if (!consoleBroker.enabled) {
      sendJson(res, 501, {
        message: 'console sessions are not configured on this proxy (PROXMOX_CONSOLE_USERNAME)',
      })
      return
    }
    let body: { node?: unknown; vmid?: unknown }
    try {
      const raw = await readBody(req, 4096)
      body = JSON.parse(raw.toString()) as typeof body
    } catch {
      sendJson(res, 400, { message: 'expected a JSON body: {node, vmid}' })
      return
    }
    const node = typeof body.node === 'string' ? body.node : ''
    const vmid = typeof body.vmid === 'number' ? body.vmid : Number.NaN
    if (!/^[A-Za-z0-9._-]{1,63}$/.test(node) || !Number.isInteger(vmid) || vmid <= 0) {
      sendJson(res, 400, { message: 'expected a JSON body: {node, vmid}' })
      return
    }
    if (vmidAllowed(settings.reservedRanges, vmid)) {
      sendJson(res, 403, { message: `vmid ${vmid} is reserved` })
      return
    }
    if (!vmidAllowed(key.vmidRanges, vmid)) {
      sendJson(res, 403, { message: `vmid ${vmid} is outside the ranges of this key` })
      return
    }
    try {
      const session = await consoleBroker.createSession(node, vmid)
      const current = settings.all
      sendJson(res, 200, {
        ...session,
        websocketBase: current.publicWsUrl || config.upstreamUrl.origin,
      })
      ops.record({
        keyName: key.name,
        method: 'POST',
        path: '/proxy/console-session',
        opClass: null,
        vmid,
        status: 200,
        queueMs: null,
        durationMs: Date.now() - started,
        upid: null,
        note: 'console-session',
      })
    } catch (err) {
      if (err instanceof ConsoleDisabledError) {
        sendJson(res, 501, { message: err.message })
        return
      }
      const status = err instanceof UpstreamError ? err.statusCode : 502
      sendJson(res, 502, { message: 'console session failed against the cluster' })
      ops.record({
        keyName: key.name,
        method: 'POST',
        path: '/proxy/console-session',
        opClass: null,
        vmid,
        status,
        queueMs: null,
        durationMs: Date.now() - started,
        upid: null,
        note: 'console-error',
      })
      log.warn('console session failed', { vmid, error: String(err) })
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

  /**
   * Ops that name a TARGET VMID in the body (move_disk / move_volume). The body
   * must be buffered to read the target, which is then reserved-checked and
   * scope-checked before forwarding (the path VMID is only the source). Not
   * admission-gated: a move is not a pool clone/delete/suspend.
   */
  async function handleBodyTargetPass(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    cls: Classified,
    key: ApiKeyRecord,
    started: number,
  ): Promise<void> {
    const method = req.method as Dispatcher.HttpMethod
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

    const base = {
      keyName: key.name,
      method: req.method ?? '',
      path: url.pathname,
      opClass: null,
      queueMs: null,
      upid: null,
    }
    const target = extractBodyVmid(body, req.headers['content-type'], cls.bodyTarget!)
    if (target != null) {
      if (vmidAllowed(settings.reservedRanges, target)) {
        sendJson(res, 403, { message: `target vmid ${target} is reserved` })
        ops.record({
          ...base,
          vmid: target,
          status: 403,
          durationMs: null,
          note: 'reserved-target',
        })
        return
      }
      if (!vmidAllowed(key.vmidRanges, target)) {
        sendJson(res, 403, { message: `target vmid ${target} is outside the ranges of this key` })
        ops.record({ ...base, vmid: target, status: 403, durationMs: null, note: 'denied-target' })
        return
      }
    }

    try {
      const headers = fwdHeaders(req, serviceAuth)
      headers['content-length'] = String(body.length)
      const r = await upstream.raw({ method, path: url.pathname + url.search, headers, body })
      const respBuf = Buffer.from(await r.body.arrayBuffer())
      ops.record({
        ...base,
        vmid: cls.pathVmid ?? target,
        status: r.statusCode,
        durationMs: Date.now() - started,
        note: 'move',
      })
      const out = respHeaders(r.headers)
      out['content-length'] = String(respBuf.length)
      res.writeHead(r.statusCode, out)
      res.end(respBuf)
    } catch (err) {
      sendJson(res, 502, { message: 'upstream unavailable' })
      log.warn('body-target forward failed', { path: url.pathname, error: String(err) })
    }
  }

  return (req, res) => {
    void (async () => {
      const started = Date.now()
      const url = new URL(req.url ?? '/', 'http://internal')

      if (url.pathname === '/proxy/health') {
        sendJson(res, 200, healthBody())
        return
      }

      const isNative = url.pathname === '/proxy/whoami' || url.pathname === '/proxy/console-session'
      if (!url.pathname.startsWith('/api2/') && !isNative) {
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
        const current = settings.all
        sendJson(res, 200, {
          name: key.name,
          vmidRanges: key.vmidRanges,
          websocketBase: current.publicWsUrl || config.upstreamUrl.origin,
          admission: {
            clone: current.cloneCap,
            delete: current.deleteCap,
            suspend: current.suspendCap,
          },
          features: { consoleSession: consoleBroker.enabled },
        })
        return
      }

      if (url.pathname === '/proxy/console-session') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { message: 'method not allowed' })
          return
        }
        await handleConsoleSession(req, res, key)
        return
      }

      if (req.headers.upgrade) {
        sendJson(res, 501, {
          message: 'websockets are not proxied; connect to the cluster node directly',
        })
        return
      }

      const cls = classify(req.method ?? 'GET', url.pathname)

      // Reserved VMIDs are off-limits to EVERY app: deny any op targeting one
      // (path VMID or task UPID), regardless of the key's own ranges.
      const targetVmid = cls.pathVmid ?? cls.upidVmid
      if (targetVmid != null && vmidAllowed(settings.reservedRanges, targetVmid)) {
        sendJson(res, 403, { message: `vmid ${targetVmid} is reserved` })
        ops.record({
          keyName: key.name,
          method: req.method ?? '',
          path: url.pathname,
          opClass: cls.opClass,
          vmid: targetVmid,
          status: 403,
          queueMs: null,
          durationMs: null,
          upid: null,
          note: 'reserved',
        })
        return
      }

      const denied = authorize(req.method ?? 'GET', cls, (vmid) =>
        vmidAllowed(key.vmidRanges, vmid),
      )
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

      if (cls.opClass) {
        // Fail-closed: having lost the cluster lock we are no longer the
        // admission authority, so a contended op must not be forwarded blind
        // (a rival proxy now owns coordination). Reads still pass through
        // handlePass: observing the cluster is never unsafe.
        if (!deps.singletonHeld()) {
          res.setHeader('retry-after', '10')
          sendJson(res, 503, { message: 'proxy is not the current cluster authority' })
          ops.record({
            keyName: key.name,
            method: req.method ?? '',
            path: url.pathname,
            opClass: cls.opClass,
            vmid: cls.pathVmid ?? cls.upidVmid,
            status: 503,
            queueMs: null,
            durationMs: null,
            upid: null,
            note: 'not-authority',
          })
          return
        }
        await handleHeavy(req, res, url, cls, key, started)
      } else if (cls.bodyTarget) {
        await handleBodyTargetPass(req, res, url, cls, key, started)
      } else await handlePass(req, res, url, cls, key, started)
    })().catch((err) => {
      log.error('data plane handler crash', { error: String(err) })
      sendJson(res, 500, { message: 'internal proxy error' })
    })
  }
}
