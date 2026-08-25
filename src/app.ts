import { randomBytes, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { FastifyInstance } from 'fastify'
import { buildAdminServer } from './admin/server.js'
import { Admission, type AdmissionOpts, type TaskFinishedEvent } from './admission/queue.js'
import type { Config } from './config.js'
import { getMeta, openDb, setMeta, type Db } from './db.js'
import { IdAllocator, VlanAllocator } from './dataplane/allocator.js'
import { VlanLeaseStore } from './dataplane/leases.js'
import { LinkedCloneService, startVlanReaper } from './dataplane/linkedclone.js'
import { createDataPlaneHandler } from './dataplane/server.js'
import { KeyStore } from './keys/store.js'
import { log } from './log.js'
import { OpsLog } from './ops.js'
import { hashPassword } from './password.js'
import { SettingsStore, type Settings } from './settings.js'
import { ClusterSnapshot } from './upstream/cluster.js'
import { Upstream } from './upstream/client.js'
import { ConsoleBroker } from './upstream/console.js'
import { HealthMonitor } from './upstream/health.js'
import { SingletonLock } from './upstream/singleton.js'

export interface App {
  config: Config
  db: Db
  keys: KeyStore
  settings: SettingsStore
  upstream: Upstream
  admission: Admission
  health: HealthMonitor
  ops: OpsLog
  singleton: SingletonLock | null
  /** Single edge server: data plane and management plane multiplexed by path. */
  edge: Server
  admin: FastifyInstance
  close(): Promise<void>
}

/** Ordered strict-tier list the admission engine consumes, derived from the
 * per-app priority values: value desc, then name asc. Value-0 apps are absent
 * (they share the round-robin bottom tier). */
function priorityOrder(appPriority: Record<string, number>): string[] {
  return Object.entries(appPriority)
    .filter(([, v]) => v > 0)
    .sort(([an, av], [bn, bv]) => bv - av || an.localeCompare(bn))
    .map(([name]) => name)
}

function admissionOptsFrom(s: Settings): AdmissionOpts {
  return {
    caps: { clone: s.cloneCap, delete: s.deleteCap, suspend: s.suspendCap },
    maxQueue: s.maxQueue,
    maxHoldMs: s.maxHoldMs,
    taskPollMs: s.taskPollMs,
    taskTimeoutMs: s.taskTimeoutMs,
    priorityApps: priorityOrder(s.appPriority),
    streamProtect: s.streamProtect,
    streamPacingMs: s.streamPacingMs,
  }
}

/**
 * Wires every module together and starts both planes. Throws
 * SingletonHeldError when another instance already guards the cluster.
 */
export async function createApp(
  config: Config,
  onFatal?: () => void,
  onRestartRequest?: () => void,
): Promise<App> {
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
  const settings = new SettingsStore(db)
  const ops = new OpsLog(db, () => settings.all.opsRingMax)
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

  const admission = new Admission(upstream, admissionOptsFrom(settings.all))
  admission.startTaskPoller()
  admission.on('task-finished', (event: TaskFinishedEvent) => {
    ops.finishTask(event.upid, event.exitstatus ?? event.note, event.taskMs)
  })
  settings.on('change', (s: Settings) => admission.applyOpts(admissionOptsFrom(s)))

  const singletonHeld = (): boolean =>
    config.singleton.disabled ? true : (singleton?.held ?? false)

  const consoleBroker = new ConsoleBroker(upstream, config.console)

  // Shared cluster view + allocators the data plane owns: id selection, VLAN
  // leasing and the linked-clone group operation, plus a reaper that frees a
  // VLAN once its pod is gone.
  const cluster = new ClusterSnapshot(upstream)
  const leases = new VlanLeaseStore(db)
  const ids = new IdAllocator(cluster)
  const vlans = new VlanAllocator(leases)
  const linkedClone = new LinkedCloneService({
    upstream,
    admission,
    cluster,
    leases,
    ids,
    vlans,
    settings,
  })
  const stopReaper = startVlanReaper(cluster, leases)

  const dataHandler = createDataPlaneHandler({
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
    singletonHeld,
    ops,
  })

  const admin = await buildAdminServer({
    config,
    keys,
    settings,
    admission,
    health,
    ops,
    upstream,
    cluster,
    leases,
    singletonHeld,
    db,
    requestRestart: onRestartRequest ?? null,
  })
  await admin.ready()

  // Single edge: the data plane owns /api2/* and /proxy/*, the management plane
  // owns everything else. Multiplexing by path in-process means the deploy is
  // one container on one port, with no sidecar reverse proxy to configure.
  const edge = createServer((req, res) => {
    const path = (req.url ?? '/').split('?', 1)[0]
    if (
      path === '/api2' ||
      path.startsWith('/api2/') ||
      path === '/proxy' ||
      path.startsWith('/proxy/')
    ) {
      dataHandler(req, res)
    } else {
      admin.routing(req, res)
    }
  })
  await new Promise<void>((resolve, reject) => {
    edge.once('error', reject)
    edge.listen(config.edgePort, config.bindHost, resolve)
  })

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    stopReaper()
    admission.stop()
    health.stop()
    // Release the cluster lock FIRST: server close can be slowed down by
    // lingering connections and the successor must be able to take over.
    if (singleton) await singleton.release()
    const edgeClosed = new Promise<void>((resolve) => edge.close(() => resolve()))
    edge.closeAllConnections()
    await Promise.all([admin.close(), edgeClosed])
    await upstream.close().catch(() => {})
    db.close()
  }

  log.info('proxmox-proxy up', {
    edgePort: config.edgePort,
    upstream: config.upstreamUrl.origin,
    singleton: config.singleton.disabled ? 'disabled' : 'held',
  })

  return {
    config,
    db,
    keys,
    settings,
    upstream,
    admission,
    health,
    ops,
    singleton,
    edge,
    admin,
    close,
  }
}
