import { randomBytes, randomUUID } from 'node:crypto'
import type { Server } from 'node:http'
import type { FastifyInstance } from 'fastify'
import { buildAdminServer } from './admin/server.js'
import { Admission, type TaskFinishedEvent } from './admission/queue.js'
import type { Config } from './config.js'
import { getMeta, openDb, setMeta, type Db } from './db.js'
import { createDataPlane } from './dataplane/server.js'
import { KeyStore } from './keys/store.js'
import { log } from './log.js'
import { OpsLog } from './ops.js'
import { hashPassword } from './password.js'
import { Upstream } from './upstream/client.js'
import { HealthMonitor } from './upstream/health.js'
import { SingletonLock } from './upstream/singleton.js'

export interface App {
  config: Config
  db: Db
  keys: KeyStore
  upstream: Upstream
  admission: Admission
  health: HealthMonitor
  ops: OpsLog
  singleton: SingletonLock | null
  dataServer: Server
  admin: FastifyInstance
  close(): Promise<void>
}

/**
 * Wires every module together and starts both planes. Throws
 * SingletonHeldError when another instance already guards the cluster.
 */
export async function createApp(config: Config, onFatal?: () => void): Promise<App> {
  const db = openDb(config.dataDir)

  // Zero-config bootstrap: anything not set in the environment is generated
  // on first boot and persisted, so the minimal .env stays minimal.
  if (!config.sessionSecret) {
    let secret = getMeta(db, 'session_secret')
    if (!secret) {
      secret = randomUUID() + randomUUID()
      setMeta(db, 'session_secret', secret)
      log.info('session secret generated and persisted')
    }
    config.sessionSecret = secret
  }
  if (!config.adminPasswordHash && !config.adminPassword) {
    let hash = getMeta(db, 'admin_password_hash')
    if (!hash) {
      const password = randomBytes(9).toString('base64url')
      hash = hashPassword(password)
      setMeta(db, 'admin_password_hash', hash)
      log.warn(`panel admin password generated (user "${config.adminUser}"): ${password}`)
      log.warn('shown only this once; set ADMIN_PASSWORD or ADMIN_PASSWORD_HASH to override')
    }
    config.adminPasswordHash = hash
  }

  const keys = new KeyStore(db, config.keysTokenUser)
  const ops = new OpsLog(db, config.opsRingMax)
  const upstream = new Upstream({
    url: config.upstreamUrl,
    caPath: config.upstreamCaPath,
    insecure: config.upstreamInsecure,
    serviceToken: config.serviceToken,
  })

  let singleton: SingletonLock | null = null
  if (!config.singleton.disabled) {
    singleton = new SingletonLock(upstream, {
      poolId: config.singleton.poolId,
      instanceId: config.instanceId,
      heartbeatMs: config.singleton.heartbeatMs,
      staleMs: config.singleton.staleMs,
      onLost: () => onFatal?.(),
    })
    await singleton.acquire()
  }

  const health = new HealthMonitor(upstream)
  health.start()

  const admission = new Admission(upstream, config.admission)
  admission.startTaskPoller()
  admission.on('task-finished', (event: TaskFinishedEvent) => {
    ops.finishTask(event.upid, event.exitstatus ?? event.note, event.taskMs)
  })

  const singletonHeld = (): boolean => (config.singleton.disabled ? true : (singleton?.held ?? false))

  const dataServer = createDataPlane({ config, keys, upstream, admission, health, singletonHeld, ops })
  await new Promise<void>((resolve, reject) => {
    dataServer.once('error', reject)
    dataServer.listen(config.dataPort, config.bindHost, resolve)
  })

  const admin = await buildAdminServer({ config, keys, admission, health, ops, singletonHeld })
  await admin.listen({ port: config.adminPort, host: config.bindHost })

  const close = async (): Promise<void> => {
    admission.stop()
    health.stop()
    await admin.close()
    await new Promise<void>((resolve) => dataServer.close(() => resolve()))
    if (singleton) await singleton.release()
    await upstream.close().catch(() => {})
    db.close()
  }

  log.info('proxmox-proxy up', {
    dataPort: config.dataPort,
    adminPort: config.adminPort,
    upstream: config.upstreamUrl.origin,
    singleton: config.singleton.disabled ? 'disabled' : 'held',
  })

  return { config, db, keys, upstream, admission, health, ops, singleton, dataServer, admin, close }
}
