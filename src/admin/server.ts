import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import fastifyCookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import fastifySwagger from '@fastify/swagger'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import type { Admission } from '../admission/queue.js'
import type { Config } from '../config.js'
import type { VlanLeaseStore } from '../dataplane/leases.js'
import { rangesOverlap, vmidAllowed, type KeyStore, type VmidRange } from '../keys/store.js'
import { log } from '../log.js'
import type { OpsLog } from '../ops.js'
import { verifyPassword } from '../password.js'
import { signSession, verifySession } from '../session.js'
import { SETTINGS_DEFAULTS, type Settings, type SettingsStore } from '../settings.js'
import { ClusterSnapshot, type ClusterVm } from '../upstream/cluster.js'
import { UpstreamError, type Upstream } from '../upstream/client.js'
import type { HealthMonitor } from '../upstream/health.js'
import {
  CreateKeyBody,
  ErrorReply,
  HealthReply,
  InventoryReply,
  KeyListReply,
  LeasesReply,
  LoginBody,
  MeReply,
  OperationsQuery,
  OperationsReply,
  QueuesReply,
  RotateKeyBody,
  SettingsPatch,
  SettingsReply,
  StatusReply,
  TaskStopBody,
  TaskStopReply,
  TokenReply,
} from './schemas.js'

export interface AdminDeps {
  config: Config
  keys: KeyStore
  settings: SettingsStore
  admission: Admission
  health: HealthMonitor
  ops: OpsLog
  upstream: Upstream
  cluster: ClusterSnapshot
  leases: VlanLeaseStore
  singletonHeld: () => boolean
}

/** A UPID is `UPID:node:...`; the node is what a task-stop call needs. */
function nodeFromUpid(upid: string): string | null {
  const parts = upid.split(':')
  if (parts[0] !== 'UPID') return null
  const node = parts[1]
  return /^[A-Za-z0-9._-]{1,63}$/.test(node) ? node : null
}

const SESSION_COOKIE = 'pp_session'
const startedAt = Date.now()

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8'),
    ) as { version?: string }
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

interface LoginAttempts {
  count: number
  resetAt: number
}

export async function buildAdminServer(deps: AdminDeps): Promise<FastifyInstance> {
  const { config, keys, settings, admission, health, ops, upstream, cluster, leases } = deps
  const version = readVersion()
  const attempts = new Map<string, LoginAttempts>()

  // forceCloseConnections: live SSE streams must never block a shutdown
  // (a hanging close would kill the process before releasing the cluster lock).
  const app = Fastify({
    logger: false,
    trustProxy: true,
    forceCloseConnections: true,
  }).withTypeProvider<TypeBoxTypeProvider>()

  await app.register(fastifyCookie)
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'proxmox-proxy admin API',
        description: 'Management plane: keys, queues, operations, status.',
        version,
      },
    },
  })

  const checkPassword = (password: string): boolean => {
    if (config.adminPasswordHash) return verifyPassword(password, config.adminPasswordHash)
    return config.adminPassword != null && password === config.adminPassword
  }

  const isPublic = (req: FastifyRequest): boolean => {
    if (!req.url.startsWith('/api/')) return true // panel statics
    if (req.method === 'POST' && req.url === '/api/session') return true
    if (req.method === 'GET' && (req.url === '/api/health' || req.url === '/api/openapi.json'))
      return true
    return false
  }

  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    if (isPublic(req)) return
    const token = req.cookies[SESSION_COOKIE]
    const session = token ? verifySession(token, config.sessionSecret) : null
    if (!session) {
      await reply.code(401).send({ message: 'unauthorized' })
    }
  })

  app.post(
    '/api/session',
    { schema: { body: LoginBody, response: { 200: MeReply, 401: ErrorReply, 429: ErrorReply } } },
    async (req, reply) => {
      const now = Date.now()
      const ip = req.ip
      const att = attempts.get(ip)
      if (att && att.resetAt > now && att.count >= 10) {
        return reply.code(429).send({ message: 'too many attempts, wait a few minutes' })
      }
      const { username, password } = req.body
      if (username !== config.adminUser || !checkPassword(password)) {
        const next = att && att.resetAt > now ? att : { count: 0, resetAt: now + 300_000 }
        next.count += 1
        attempts.set(ip, next)
        return reply.code(401).send({ message: 'invalid credentials' })
      }
      attempts.delete(ip)
      const ttlMs = settings.all.sessionTtlHours * 3_600_000
      const cookie = signSession({ u: username, exp: now + ttlMs }, config.sessionSecret)
      return reply
        .setCookie(SESSION_COOKIE, cookie, {
          httpOnly: true,
          sameSite: 'strict',
          path: '/',
          maxAge: Math.floor(ttlMs / 1000),
        })
        .send({ username })
    },
  )

  app.delete('/api/session', { schema: { response: { 204: {} } } }, async (_req, reply) => {
    return reply.clearCookie(SESSION_COOKIE, { path: '/' }).code(204).send()
  })

  app.get('/api/me', { schema: { response: { 200: MeReply } } }, async (req) => {
    const session = verifySession(req.cookies[SESSION_COOKIE] ?? '', config.sessionSecret)
    return { username: session?.u ?? '' }
  })

  app.get('/api/health', { schema: { response: { 200: HealthReply } } }, async () => ({
    status: health.state.ok && deps.singletonHeld() ? 'ok' : 'degraded',
    upstreamOk: health.state.ok,
    singletonHeld: deps.singletonHeld(),
  }))

  app.get('/api/status', { schema: { response: { 200: StatusReply } } }, async () => {
    const snapshot = admission.snapshot()
    return {
      version,
      startedAt,
      uptimeMs: Date.now() - startedAt,
      singleton: {
        enabled: !config.singleton.disabled,
        held: deps.singletonHeld(),
        instanceId: config.instanceId,
      },
      upstream: {
        ok: health.state.ok,
        version: health.state.version,
        checkedAt: health.state.checkedAt,
        error: health.state.error,
      },
      admission: snapshot.classes.map((c) => ({
        name: c.name,
        cap: c.cap,
        outOfBand: c.outOfBand,
        effectiveCap: c.effectiveCap,
        active: c.running.length,
        waiting: c.waiting.length,
      })),
    }
  })

  app.get('/api/queues', { schema: { response: { 200: QueuesReply } } }, async () =>
    admission.snapshot(),
  )

  app.get('/api/keys', { schema: { response: { 200: KeyListReply } } }, async () => ({
    keys: keys.list(),
  }))

  app.post(
    '/api/keys',
    {
      schema: {
        body: CreateKeyBody,
        response: { 201: TokenReply, 409: ErrorReply, 400: ErrorReply },
      },
    },
    async (req, reply) => {
      const { name, vmidRanges, comment } = req.body
      if (keys.get(name)) return reply.code(409).send({ message: `key already exists: ${name}` })
      // Reserved ranges are the only hard boundary: they are enforced as
      // configuration, not per-operation, so an app range may never include a
      // reserved VMID. App ranges MAY overlap each other on purpose (the same
      // logical app driven from several environments, e.g. prod plus local dev,
      // shares one cluster range); the allocator assigns from real occupancy so
      // co-located apps never double-claim a VMID. The trade-off is that
      // overlapping apps see each other's VMs in the shared band (opacity is
      // per-range), which is the intended behaviour for those environments.
      if (rangesOverlap(vmidRanges as VmidRange[], settings.reservedRanges)) {
        return reply.code(400).send({ message: 'vmid ranges overlap a reserved range' })
      }
      try {
        const token = keys.create(name, vmidRanges as VmidRange[], comment ?? '')
        log.info('api key created', { name })
        return reply.code(201).send({ name, token })
      } catch (err) {
        return reply.code(400).send({ message: String(err instanceof Error ? err.message : err) })
      }
    },
  )

  app.post(
    '/api/keys/:name/rotate',
    {
      schema: {
        params: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        body: RotateKeyBody,
        response: { 200: TokenReply, 404: ErrorReply },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string }
      const graceHours = req.body.graceHours ?? 24
      try {
        const token = keys.rotate(name, graceHours * 3_600_000)
        log.info('api key rotated', { name, graceHours })
        return reply.send({ name, token })
      } catch {
        return reply.code(404).send({ message: `unknown or revoked key: ${name}` })
      }
    },
  )

  app.delete(
    '/api/keys/:name',
    {
      schema: {
        params: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        response: { 204: {}, 404: ErrorReply },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string }
      if (!keys.revoke(name)) return reply.code(404).send({ message: `unknown key: ${name}` })
      log.info('api key revoked', { name })
      return reply.code(204).send()
    },
  )

  // Hard-delete a revoked key's record (remove its trace). Revoked-first: an
  // active key must be revoked before it can be deleted, to avoid a fat-finger
  // removal of a live app.
  app.delete(
    '/api/keys/:name/purge',
    {
      schema: {
        params: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        response: { 204: {}, 404: ErrorReply, 409: ErrorReply },
      },
    },
    async (req, reply) => {
      const { name } = req.params as { name: string }
      const key = keys.get(name)
      if (!key) return reply.code(404).send({ message: `unknown key: ${name}` })
      if (key.enabled) {
        return reply.code(409).send({ message: 'revoke the key before deleting its record' })
      }
      keys.remove(name)
      log.info('api key record purged', { name })
      return reply.code(204).send()
    },
  )

  app.get(
    '/api/operations',
    { schema: { querystring: OperationsQuery, response: { 200: OperationsReply } } },
    async (req) => ({ rows: ops.list(req.query) }),
  )

  app.get('/api/settings', { schema: { response: { 200: SettingsReply } } }, async () => ({
    settings: settings.all,
    defaults: SETTINGS_DEFAULTS,
  }))

  app.put(
    '/api/settings',
    { schema: { body: SettingsPatch, response: { 200: SettingsReply, 400: ErrorReply } } },
    async (req, reply) => {
      const patch = req.body as Partial<Settings>
      // A reserved range may never cover a VMID an app already owns: reject the
      // change here (settings has no view of keys) before it is persisted.
      if (patch.reserved !== undefined) {
        // Only live keys block a reserved range; a revoked key is dead, so
        // reserving its old range is not obstruction.
        const clashing = keys
          .list()
          .find(
            (k) =>
              k.enabled &&
              rangesOverlap(patch.reserved as VmidRange[], k.vmidRanges as VmidRange[]),
          )
        if (clashing) {
          return reply.code(400).send({
            message: `reserved range overlaps the ranges of key "${clashing.name}"`,
          })
        }
      }
      try {
        const updated = settings.update(patch)
        return reply.send({ settings: updated, defaults: SETTINGS_DEFAULTS })
      } catch (err) {
        return reply.code(400).send({ message: String(err instanceof Error ? err.message : err) })
      }
    },
  )

  app.post('/api/settings/reset', { schema: { response: { 200: SettingsReply } } }, async () => ({
    settings: settings.reset(),
    defaults: SETTINGS_DEFAULTS,
  }))

  // Red button: stop a running Proxmox task (a wedged clone, a stray op). The
  // admission task poller notices the stop on its next tick and frees the slot.
  app.post(
    '/api/tasks/stop',
    {
      schema: {
        body: TaskStopBody,
        response: { 200: TaskStopReply, 400: ErrorReply, 502: ErrorReply },
      },
    },
    async (req, reply) => {
      const { upid } = req.body
      const node = nodeFromUpid(upid)
      if (!node) return reply.code(400).send({ message: 'malformed UPID' })
      try {
        await upstream.api('DELETE', `/nodes/${node}/tasks/${encodeURIComponent(upid)}`)
        log.warn('task stopped from the panel', { upid, node })
        ops.record({
          keyName: '(admin)',
          method: 'DELETE',
          path: `/nodes/${node}/tasks/${upid}`,
          opClass: null,
          vmid: null,
          status: 200,
          queueMs: null,
          durationMs: null,
          upid,
          note: 'stopped-by-admin',
        })
        return reply.send({ upid, node, stopped: true })
      } catch (err) {
        const message = err instanceof UpstreamError ? err.message : String(err)
        return reply.code(502).send({ message })
      }
    },
  )

  // Per-app cluster inventory: which live VMs each app's key ranges own, plus
  // the VMs that belong to no range (manual or orphaned). Sourced from the
  // cluster itself, so it surfaces residue an app may have lost track of.
  app.get('/api/inventory', { schema: { response: { 200: InventoryReply } } }, async () => {
    let raw: ClusterVm[]
    try {
      raw = await cluster.vms()
    } catch (err) {
      log.warn('inventory read failed', { error: String(err) })
      return { reserved: [], apps: [], unassigned: [], upstreamOk: false }
    }
    const byVmid = (a: { vmid: number }, b: { vmid: number }): number => a.vmid - b.vmid
    // Decorate with the reserved flag at response time (not cached) so a change
    // to the reserved ranges shows up immediately.
    const reservedRanges = settings.reservedRanges
    const vms = raw.map((vm) => ({ ...vm, reserved: vmidAllowed(reservedRanges, vm.vmid) }))
    // A VM lands in exactly one bucket: reserved wins over app ownership, which
    // wins over unassigned. Blocks sort apps by name, VMs by vmid.
    const reserved = vms.filter((vm) => vm.reserved).sort(byVmid)
    const apps = keys
      .list()
      .map((k) => ({
        name: k.name,
        vmidRanges: k.vmidRanges,
        vms: vms
          .filter((vm) => !vm.reserved && vmidAllowed(k.vmidRanges as VmidRange[], vm.vmid))
          .sort(byVmid),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
    const assigned = new Set<number>()
    for (const vm of reserved) assigned.add(vm.vmid)
    for (const app of apps) for (const vm of app.vms) assigned.add(vm.vmid)
    const unassigned = vms.filter((vm) => !assigned.has(vm.vmid)).sort(byVmid)
    return { reserved, apps, unassigned, upstreamOk: true }
  })

  // VLAN tags the proxy has leased to linked-clone groups (self-freed when the
  // pod is gone). Surfaced so an operator can see what the linked range holds.
  app.get('/api/leases', { schema: { response: { 200: LeasesReply } } }, async () => ({
    leases: leases.list(),
  }))

  // Live queue/status stream for the panel.
  app.get('/api/events', (req, reply) => {
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = (event: string, data: unknown): void => {
      raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    send('queues', admission.snapshot())
    const onChange = (snapshot: unknown): void => send('queues', snapshot)
    admission.on('change', onChange)
    const ping = setInterval(() => raw.write(': ping\n\n'), 15_000)
    req.raw.on('close', () => {
      admission.off('change', onChange)
      clearInterval(ping)
    })
  })

  app.get('/api/openapi.json', async () => app.swagger())

  // Panel statics (built by Vite). In dev without a build, the API still works.
  const panelDist = join(import.meta.dirname, '../..', 'panel', 'dist')
  if (existsSync(panelDist)) {
    await app.register(fastifyStatic, { root: panelDist })
    app.setNotFoundHandler(async (req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.sendFile('index.html')
      }
      return reply.code(404).send({ message: 'not found' })
    })
  } else {
    app.get('/', async () => ({ message: 'proxmox-proxy admin API (panel not built)' }))
  }

  return app
}
