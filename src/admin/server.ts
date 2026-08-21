import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import fastifyCookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import fastifySwagger from '@fastify/swagger'
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import type { Admission } from '../admission/queue.js'
import type { Config } from '../config.js'
import type { KeyStore, VmidRange } from '../keys/store.js'
import { log } from '../log.js'
import type { OpsLog } from '../ops.js'
import { verifyPassword } from '../password.js'
import { signSession, verifySession } from '../session.js'
import type { HealthMonitor } from '../upstream/health.js'
import {
  CreateKeyBody,
  ErrorReply,
  HealthReply,
  KeyListReply,
  LoginBody,
  MeReply,
  OperationsQuery,
  OperationsReply,
  QueuesReply,
  RotateKeyBody,
  StatusReply,
  TokenReply,
} from './schemas.js'

export interface AdminDeps {
  config: Config
  keys: KeyStore
  admission: Admission
  health: HealthMonitor
  ops: OpsLog
  singletonHeld: () => boolean
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
  const { config, keys, admission, health, ops } = deps
  const version = readVersion()
  const attempts = new Map<string, LoginAttempts>()

  const app = Fastify({ logger: false, trustProxy: true }).withTypeProvider<TypeBoxTypeProvider>()

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
      const cookie = signSession(
        { u: username, exp: now + config.sessionTtlMs },
        config.sessionSecret,
      )
      return reply
        .setCookie(SESSION_COOKIE, cookie, {
          httpOnly: true,
          sameSite: 'strict',
          path: '/',
          maxAge: Math.floor(config.sessionTtlMs / 1000),
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

  app.get(
    '/api/operations',
    { schema: { querystring: OperationsQuery, response: { 200: OperationsReply } } },
    async (req) => ({ rows: ops.list(req.query) }),
  )

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
