import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import { pipeline } from 'node:stream'
import type { Dispatcher } from 'undici'
import { authorize, classify, vmidFromUpid, type Classified } from '../admission/classify.js'
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
import type { ClusterSnapshot } from '../upstream/cluster.js'
import type { HealthMonitor } from '../upstream/health.js'
import { UpstreamError, type Upstream } from '../upstream/client.js'
import type { IdAllocator } from './allocator.js'
import {
  GROUP_ACTIONS,
  LinkedCloneError,
  type GroupAction,
  type LinkedCloneRequest,
  type LinkedCloneService,
} from './linkedclone.js'

export interface DataPlaneDeps {
  config: Config
  keys: KeyStore
  settings: SettingsStore
  upstream: Upstream
  admission: Admission
  health: HealthMonitor
  console: ConsoleBroker
  cluster: ClusterSnapshot
  ids: IdAllocator
  linkedClone: LinkedCloneService
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
// A filtered read must buffer the upstream response to trim it; cap it so a
// hostile `?limit=huge` cannot force an unbounded allocation.
const MAX_FILTERED_BODY = 16 * 1024 * 1024

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

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

/** Read an upstream response body up to `limit` bytes; null if it exceeds it. */
async function readCappedBody(
  body: AsyncIterable<Buffer> & { destroy?: () => void },
  limit: number,
): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of body) {
    size += chunk.length
    if (size > limit) {
      body.destroy?.()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
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

/** Return a body with `param` set to `value`, preserving the encoding. */
function injectBodyVmid(
  body: Buffer,
  contentType: string | undefined,
  param: string,
  value: number,
): Buffer {
  if (contentType?.includes('application/json')) {
    const obj = body.length ? (JSON.parse(body.toString()) as Record<string, unknown>) : {}
    obj[param] = value
    return Buffer.from(JSON.stringify(obj))
  }
  const params = new URLSearchParams(body.toString())
  params.set(param, String(value))
  return Buffer.from(params.toString())
}

/**
 * The data-plane request handler. Mounted by the app under a single edge server
 * that routes `/api2/*` and `/proxy/*` here; there is no separate listener.
 */
export function createDataPlaneHandler(deps: DataPlaneDeps): RequestListener {
  const {
    config,
    keys,
    settings,
    upstream,
    admission,
    health,
    console: consoleBroker,
    cluster,
    ids,
    linkedClone,
    ops,
  } = deps
  const serviceAuth = `PVEAPIToken=${config.serviceToken}`

  // /proxy/health is unauthenticated (docker healthcheck, app probes), so it
  // discloses only liveness, never the upstream version string.
  const healthBody = (): Record<string, unknown> => ({
    status: health.state.ok && deps.singletonHeld() ? 'ok' : 'degraded',
    upstreamOk: health.state.ok,
    singletonHeld: deps.singletonHeld(),
  })

  /** true = template, false = not, 'unknown' = the cluster could not be read. */
  async function templateState(vmid: number): Promise<boolean | 'unknown'> {
    try {
      return (await cluster.byVmid(vmid))?.template === true
    } catch {
      return 'unknown'
    }
  }

  /**
   * Templates are read-only through the proxy: a template is never deleted and
   * never mutated (cloning FROM it is the one write allowed, handled elsewhere).
   * Returns a 403 message, the '__unavailable__' sentinel (503) or null (allow).
   * Fails closed on EVERY write when the cluster cannot be read, so a golden
   * image is never mutated or destroyed blind (a write would 502 anyway).
   */
  async function templateGuard(method: string, cls: Classified): Promise<string | null> {
    if (READ_METHODS.has(method) || cls.opClass === 'clone' || cls.pathVmid == null) return null
    const state = await templateState(cls.pathVmid)
    if (state === true) {
      return 'templates are read-only through the proxy; cloning is the only write allowed'
    }
    if (state === 'unknown') {
      log.warn('template guard could not read the cluster, refusing write', {
        vmid: cls.pathVmid,
        method,
      })
      return '__unavailable__'
    }
    return null
  }

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

    // A clone names its target in the body. The proxy owns id selection: if the
    // app omits newid we assign the lowest free id in its ranges and inject it;
    // if it sends one, it must be in range. The created id is returned to the app
    // in the `x-proxy-newid` response header (a qmclone UPID carries the SOURCE
    // vmid, not the new one, so the header is the only reliable source).
    let assignedNewid: number | null = null
    let cloneNewid: number | null = null
    if (cls.opClass === 'clone') {
      const ct = req.headers['content-type']
      let newid = extractBodyVmid(body, ct, 'newid')
      if (newid == null) {
        newid = await ids.allocate(key.vmidRanges)
        if (newid == null) {
          sendJson(res, 507, { message: 'the vmid ranges of this key are exhausted' })
          ops.record({
            ...base,
            status: 507,
            queueMs: null,
            durationMs: null,
            upid: null,
            note: 'ranges-exhausted',
          })
          return
        }
        try {
          body = injectBodyVmid(body, ct, 'newid', newid)
        } catch {
          // A malformed body (e.g. broken JSON) must not strand the reserved id.
          ids.release(newid)
          sendJson(res, 400, { message: 'malformed clone request body' })
          ops.record({
            ...base,
            status: 400,
            queueMs: null,
            durationMs: null,
            upid: null,
            note: 'bad-body',
          })
          return
        }
        assignedNewid = newid
      } else if (!vmidAllowed(key.vmidRanges, newid)) {
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
      cloneNewid = newid // the effective new id (assigned or provided), for the header
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
      if (assignedNewid != null) ids.release(assignedNewid)
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

      // A freshly assigned id that did not take must be handed back at once; a
      // successful clone means the inventory is now stale, so refresh it.
      if (assignedNewid != null && r.statusCode >= 400) ids.release(assignedNewid)
      if (cls.opClass === 'clone' && r.statusCode < 400) cluster.invalidate()

      ops.record({
        ...base,
        vmid: assignedNewid ?? base.vmid,
        status: r.statusCode,
        queueMs: grant.queueMs,
        durationMs: Date.now() - started,
        upid,
        note: upid ? 'running' : null,
      })

      settled = true
      const out = respHeaders(r.headers)
      out['content-length'] = String(respBuf.length)
      // Hand the created VMID back explicitly: the app cannot derive it from the
      // qmclone UPID (that carries the source/template vmid on a real cluster).
      if (cloneNewid != null && r.statusCode < 400) out['x-proxy-newid'] = String(cloneNewid)
      res.writeHead(r.statusCode, out)
      res.end(respBuf)
    } catch (err) {
      grant.release('upstream-error')
      if (assignedNewid != null) ids.release(assignedNewid)
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

  /**
   * Native endpoint: clone a group of templates as one isolated pod (linked
   * clones sharing a freshly leased VLAN), returned already configured. The
   * proxy owns id and VLAN selection; see LinkedCloneService.
   */
  async function handleLinkedClone(
    req: IncomingMessage,
    res: ServerResponse,
    key: ApiKeyRecord,
  ): Promise<void> {
    const started = Date.now()
    let body: LinkedCloneRequest
    try {
      const raw = await readBody(req, MAX_HEAVY_BODY)
      body = JSON.parse(raw.toString()) as LinkedCloneRequest
    } catch {
      sendJson(res, 400, { message: 'expected a JSON body: {node, clones:[{template}], vlan?}' })
      return
    }
    const abort = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) abort.abort()
    })
    try {
      const result = await linkedClone.run(key, body, abort.signal)
      sendJson(res, 200, result)
      ops.record({
        keyName: key.name,
        method: 'POST',
        path: '/proxy/linked-clone',
        opClass: 'clone',
        vmid: result.clones[0]?.vmid ?? null,
        status: 200,
        queueMs: null,
        durationMs: Date.now() - started,
        upid: null,
        note: `linked-clone vlan=${result.vlan} n=${result.clones.length}`,
      })
    } catch (err) {
      // Only our own LinkedCloneError messages are safe to return; anything else
      // could leak upstream/internal detail, so it gets a generic message.
      const status = err instanceof LinkedCloneError ? err.status : 502
      const message = err instanceof LinkedCloneError ? err.message : 'linked clone failed'
      if (status !== 499) sendJson(res, status, { message })
      ops.record({
        keyName: key.name,
        method: 'POST',
        path: '/proxy/linked-clone',
        opClass: 'clone',
        vmid: null,
        status: status === 499 ? null : status,
        queueMs: null,
        durationMs: Date.now() - started,
        upid: null,
        note: status === 499 ? 'client-gone' : 'linked-clone-error',
      })
      if (status >= 500 && status !== 503) {
        log.warn('linked clone failed', { key: key.name, status, error: message })
      }
    }
  }

  /** Map a group-op failure to the right response and return {status, note} for
   * the ops log. Surfaces admission back-pressure as a retryable 429 (not 502)
   * and sends no body when the client is already gone. */
  function groupError(res: ServerResponse, err: unknown): { status: number | null; note: string } {
    if (err instanceof QueueFullError || err instanceof HoldTimeoutError) {
      res.setHeader('retry-after', String(err.retryAfterSec))
      sendJson(res, 429, { message: `cluster busy, retry in ${err.retryAfterSec}s` })
      return { status: 429, note: err instanceof QueueFullError ? 'queue-full' : 'hold-timeout' }
    }
    if (err instanceof ClientGoneError) return { status: null, note: 'client-gone' }
    const status = err instanceof LinkedCloneError ? err.status : 502
    if (status === 499) return { status: null, note: 'client-gone' }
    const message = err instanceof LinkedCloneError ? err.message : 'group operation failed'
    sendJson(res, status, { message })
    return { status, note: 'group-op-error' }
  }

  /** A group is the unit of operation: one call destroys every member and frees
   * the VLAN, addressed by the tag the group was created with. */
  async function handleGroupDestroy(
    req: IncomingMessage,
    res: ServerResponse,
    key: ApiKeyRecord,
    vlan: number,
  ): Promise<void> {
    const started = Date.now()
    const abort = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) abort.abort()
    })
    const path = `/proxy/linked-clone/${vlan}`
    try {
      const result = await linkedClone.destroyGroup(key, vlan, abort.signal)
      sendJson(res, 200, result)
      ops.record({
        keyName: key.name,
        method: 'DELETE',
        path,
        opClass: 'delete',
        vmid: null,
        status: 200,
        queueMs: null,
        durationMs: Date.now() - started,
        upid: null,
        note: `group-destroy n=${result.destroyed.length}`,
      })
    } catch (err) {
      const { status, note } = groupError(res, err)
      ops.record({
        keyName: key.name,
        method: 'DELETE',
        path,
        opClass: 'delete',
        vmid: null,
        status,
        queueMs: null,
        durationMs: Date.now() - started,
        upid: null,
        note,
      })
    }
  }

  /** One power action applied to every member of a group. */
  async function handleGroupPower(
    req: IncomingMessage,
    res: ServerResponse,
    key: ApiKeyRecord,
    vlan: number,
    action: GroupAction,
  ): Promise<void> {
    const started = Date.now()
    const abort = new AbortController()
    res.on('close', () => {
      if (!res.writableEnded) abort.abort()
    })
    const path = `/proxy/linked-clone/${vlan}/${action}`
    try {
      const result = await linkedClone.groupPower(key, vlan, action, abort.signal)
      sendJson(res, 200, result)
      ops.record({
        keyName: key.name,
        method: 'POST',
        path,
        opClass: action === 'suspend' ? 'suspend' : null,
        vmid: null,
        status: 200,
        queueMs: null,
        durationMs: Date.now() - started,
        upid: null,
        note: `group-${action} ok=${result.members.filter((m) => m.ok).length}/${result.members.length}`,
      })
    } catch (err) {
      const { status, note } = groupError(res, err)
      ops.record({
        keyName: key.name,
        method: 'POST',
        path,
        opClass: action === 'suspend' ? 'suspend' : null,
        vmid: null,
        status,
        queueMs: null,
        durationMs: Date.now() - started,
        upid: null,
        note,
      })
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
   * A cluster-wide LIST read, filtered to the key's own VMIDs before it reaches
   * the app: the proxy is opaque about every VM outside the key's ranges. The
   * response is buffered so its `data` array can be trimmed, then re-sent.
   */
  async function handleFilteredRead(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    cls: Classified,
    key: ApiKeyRecord,
  ): Promise<void> {
    const method = req.method as Dispatcher.HttpMethod
    try {
      const headers = fwdHeaders(req, serviceAuth)
      delete headers['accept-encoding'] // keep the JSON parseable for filtering
      const r = await upstream.raw({ method, path: url.pathname + url.search, headers })
      const respBuf = await readCappedBody(r.body, MAX_FILTERED_BODY)
      if (respBuf === null) {
        sendJson(res, 502, { message: 'upstream response too large to filter' })
        return
      }
      let out = respBuf
      if (r.statusCode < 400) {
        try {
          const parsed = JSON.parse(respBuf.toString()) as { data?: unknown[] }
          if (Array.isArray(parsed.data)) {
            parsed.data = filterListData(parsed.data, cls.listScope!, key.vmidRanges)
            out = Buffer.from(JSON.stringify(parsed))
          }
        } catch {
          // not the shape we expected: forward untouched rather than break
        }
      }
      const respOut = respHeaders(r.headers)
      respOut['content-length'] = String(out.length)
      delete respOut['content-encoding']
      res.writeHead(r.statusCode, respOut)
      res.end(out)
    } catch (err) {
      sendJson(res, 502, { message: 'upstream unavailable' })
      log.warn('filtered read failed', { path: url.pathname, error: String(err) })
    }
  }

  /**
   * Ops that name a TARGET VMID in the body (move_disk / move_volume). The body
   * must be buffered to read the target, which is then scope-checked before
   * forwarding (the path VMID is only the source). Not admission-gated: a move
   * is not a pool clone/delete/suspend.
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
      if (!vmidAllowed(key.vmidRanges, target)) {
        sendJson(res, 403, { message: `target vmid ${target} is outside the ranges of this key` })
        ops.record({ ...base, vmid: target, status: 403, durationMs: null, note: 'denied-target' })
        return
      }
      // The target VMID is in range, but a move must never land on a template
      // (that would mutate a golden image). Same fail-closed rule as writes.
      const ts = await templateState(target)
      if (ts === true) {
        sendJson(res, 403, { message: `target vmid ${target} is a template and is read-only` })
        ops.record({
          ...base,
          vmid: target,
          status: 403,
          durationMs: null,
          note: 'template-target',
        })
        return
      }
      if (ts === 'unknown') {
        res.setHeader('retry-after', '5')
        sendJson(res, 503, { message: 'cannot verify the target right now, retry shortly' })
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

      // /proxy/linked-clone/{vlan} (DELETE = destroy group) and
      // /proxy/linked-clone/{vlan}/{action} (POST = group power op).
      const groupPath = /^\/proxy\/linked-clone\/(\d+)(?:\/([a-z]+))?$/.exec(url.pathname)
      const isNative =
        url.pathname === '/proxy/whoami' ||
        url.pathname === '/proxy/console-session' ||
        url.pathname === '/proxy/linked-clone' ||
        groupPath != null
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
          linkedVlanRange: current.linkedVlanRange,
          features: {
            consoleSession: consoleBroker.enabled,
            linkedClone: current.linkedVlanRange != null,
            proxyAssignsNewid: true,
          },
        })
        return
      }

      // A refused native call is still RECORDED: an app hitting a route with
      // the wrong method is exactly the kind of thing a later forensic needs
      // to see in the ledger (a 405 that left no trace cost a real diagnosis).
      const recordRefusal = (status: number, note: string): void => {
        ops.record({
          keyName: key.name,
          method: req.method ?? '',
          path: url.pathname,
          opClass: null,
          vmid: null,
          status,
          queueMs: null,
          durationMs: null,
          upid: null,
          note,
        })
      }

      if (url.pathname === '/proxy/console-session') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { message: 'method not allowed' })
          recordRefusal(405, 'method-not-allowed')
          return
        }
        await handleConsoleSession(req, res, key)
        return
      }

      // Native state mutations (create / power / destroy a group) mutate the
      // cluster, so they obey the same fail-closed rule as /api2 heavy ops: when
      // we have lost the singleton lock a rival proxy owns coordination and we
      // must not act. whoami/health/console-session are reads and stay exempt.
      if ((url.pathname === '/proxy/linked-clone' || groupPath != null) && !deps.singletonHeld()) {
        res.setHeader('retry-after', '10')
        sendJson(res, 503, { message: 'proxy is not the current cluster authority' })
        ops.record({
          keyName: key.name,
          method: req.method ?? '',
          path: url.pathname,
          opClass: null,
          vmid: null,
          status: 503,
          queueMs: null,
          durationMs: null,
          upid: null,
          note: 'not-authority',
        })
        return
      }

      if (url.pathname === '/proxy/linked-clone') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { message: 'method not allowed' })
          recordRefusal(405, 'method-not-allowed')
          return
        }
        await handleLinkedClone(req, res, key)
        return
      }

      if (groupPath) {
        const vlan = Number(groupPath[1])
        const action = groupPath[2]
        if (req.method === 'DELETE' && !action) {
          await handleGroupDestroy(req, res, key, vlan)
          return
        }
        if (req.method === 'POST' && action) {
          if (!GROUP_ACTIONS.includes(action as GroupAction)) {
            sendJson(res, 400, { message: `unknown group action: ${action}` })
            recordRefusal(400, `unknown-group-action ${action}`)
            return
          }
          await handleGroupPower(req, res, key, vlan, action as GroupAction)
          return
        }
        sendJson(res, 405, { message: 'method not allowed' })
        recordRefusal(405, 'method-not-allowed')
        return
      }

      if (req.headers.upgrade) {
        sendJson(res, 501, {
          message: 'websockets are not proxied; connect to the cluster node directly',
        })
        return
      }

      const method = req.method ?? 'GET'
      // Classify (and thus scope) on the DECODED path so a percent-encoded VMID
      // (e.g. /qemu/%31%30%30/) cannot slip past extraction and read a foreign
      // VM. Reject a path whose decoding changes its segment structure (an
      // encoded slash) rather than guessing what it meant.
      let scanPath: string
      try {
        scanPath = decodeURIComponent(url.pathname)
      } catch {
        sendJson(res, 400, { message: 'malformed path' })
        return
      }
      if (scanPath.split('/').length !== url.pathname.split('/').length) {
        sendJson(res, 400, { message: 'encoded path separators are not allowed' })
        return
      }
      const cls = classify(method, scanPath)

      const denied = authorize(method, cls, (vmid) => vmidAllowed(key.vmidRanges, vmid))
      if (denied) {
        sendJson(res, 403, { message: denied })
        ops.record({
          keyName: key.name,
          method,
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

      // Templates are read-only through the proxy and never deleted.
      const templateDenied = await templateGuard(method, cls)
      if (templateDenied) {
        if (templateDenied === '__unavailable__') {
          res.setHeader('retry-after', '5')
          sendJson(res, 503, { message: 'cannot verify the target right now, retry shortly' })
        } else {
          sendJson(res, 403, { message: templateDenied })
          ops.record({
            keyName: key.name,
            method,
            path: url.pathname,
            opClass: cls.opClass,
            vmid: cls.pathVmid,
            status: 403,
            queueMs: null,
            durationMs: null,
            upid: null,
            note: 'template-protected',
          })
        }
        return
      }

      if (cls.listScope && READ_METHODS.has(method)) {
        await handleFilteredRead(req, res, url, cls, key)
        return
      }

      // Fail-closed: having lost the cluster lock we are no longer the
      // authority, so a state-mutating write (contended pool op OR a
      // disk/volume move) must not be forwarded blind while a rival proxy owns
      // coordination. Reads still pass: observing the cluster is never unsafe.
      if ((cls.opClass || cls.bodyTarget) && !deps.singletonHeld()) {
        res.setHeader('retry-after', '10')
        sendJson(res, 503, { message: 'proxy is not the current cluster authority' })
        ops.record({
          keyName: key.name,
          method,
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

      if (cls.opClass) {
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

/** A guest VMID on a list row, coerced from number OR numeric string; null if
 * the row names no guest (an infra/ISO/shared row). */
function rowVmid(row: unknown): number | null {
  const raw = (row as { vmid?: unknown }).vmid
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Trim a Proxmox list `data` array to the entries the key may see. */
function filterListData(
  data: unknown[],
  scope: NonNullable<Classified['listScope']>,
  ranges: [number, number][],
): unknown[] {
  if (scope === 'resources' || scope === 'storage') {
    // Keep rows that name no guest (nodes, storage, pools, ISOs, templates) and
    // in-range guest rows only. A foreign guest VMID (number or string) drops.
    return data.filter((row) => {
      const vmid = rowVmid(row)
      return vmid == null || vmidAllowed(ranges, vmid)
    })
  }
  if (scope === 'guests') {
    return data.filter((row) => {
      const vmid = rowVmid(row)
      return vmid != null && vmidAllowed(ranges, vmid)
    })
  }
  // tasks: keep only tasks that target one of the key's VMIDs.
  return data.filter((row) => {
    const t = row as { upid?: unknown; id?: unknown }
    let vmid: number | null = null
    if (typeof t.upid === 'string') vmid = vmidFromUpid(t.upid)
    if (vmid == null && t.id != null) {
      const n = Number.parseInt(String(t.id), 10)
      vmid = Number.isInteger(n) ? n : null
    }
    return vmid != null && vmidAllowed(ranges, vmid)
  })
}
