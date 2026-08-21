import { randomUUID } from 'node:crypto'

export const OP_CLASSES = ['clone', 'delete', 'suspend'] as const
export type OpClassName = (typeof OP_CLASSES)[number]

export interface Config {
  upstreamUrl: URL
  upstreamCaPath: string | null
  upstreamInsecure: boolean
  /** Normalized "user@realm!tokenid=secret", no PVEAPIToken= prefix. */
  serviceToken: string
  publicWsUrl: string
  keysTokenUser: string
  dataDir: string
  bindHost: string
  dataPort: number
  adminPort: number
  adminUser: string
  adminPasswordHash: string | null
  adminPassword: string | null
  sessionSecret: string
  sessionTtlMs: number
  singleton: {
    disabled: boolean
    poolId: string
    heartbeatMs: number
    staleMs: number
  }
  admission: {
    caps: Record<OpClassName, number>
    maxQueue: number
    maxHoldMs: number
    taskPollMs: number
    taskTimeoutMs: number
  }
  opsRingMax: number
  instanceId: string
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name]?.trim()
  if (!v) throw new Error(`Missing required env var ${name}`)
  return v
}

function optional(env: NodeJS.ProcessEnv, name: string): string | null {
  const v = env[name]?.trim()
  return v ? v : null
}

function int(env: NodeJS.ProcessEnv, name: string, dflt: number): number {
  const v = env[name]?.trim()
  if (!v) return dflt
  const n = Number.parseInt(v, 10)
  if (!Number.isFinite(n) || n < 0) throw new Error(`Env var ${name} must be a non-negative integer`)
  return n
}

function bool(env: NodeJS.ProcessEnv, name: string, dflt = false): boolean {
  const v = env[name]?.trim().toLowerCase()
  if (!v) return dflt
  return v === 'true' || v === '1' || v === 'yes'
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const upstreamUrl = new URL(required(env, 'PROXMOX_UPSTREAM_URL'))

  let serviceToken = required(env, 'PROXMOX_SERVICE_TOKEN')
  if (serviceToken.startsWith('PVEAPIToken=')) serviceToken = serviceToken.slice('PVEAPIToken='.length)
  if (!/^[^@!=\s]+@[^@!=\s]+![^@!=\s]+=.+$/.test(serviceToken)) {
    throw new Error('PROXMOX_SERVICE_TOKEN must look like user@realm!tokenid=secret')
  }

  // Both optional: when neither is set, a password is generated on first
  // boot, persisted (hashed) and printed once. See createApp.
  const adminPasswordHash = optional(env, 'ADMIN_PASSWORD_HASH')
  const adminPassword = optional(env, 'ADMIN_PASSWORD')

  // Empty = auto-generated and persisted on first boot. See createApp.
  const sessionSecret = optional(env, 'SESSION_SECRET') ?? ''

  return {
    upstreamUrl,
    upstreamCaPath: optional(env, 'PROXMOX_UPSTREAM_TLS_CA'),
    upstreamInsecure: bool(env, 'PROXMOX_UPSTREAM_TLS_INSECURE'),
    serviceToken,
    publicWsUrl: optional(env, 'PROXMOX_PUBLIC_WS_URL') ?? upstreamUrl.origin,
    keysTokenUser: optional(env, 'KEYS_TOKEN_USER') ?? 'svc-proxy@pve',
    dataDir: optional(env, 'DATA_DIR') ?? './data',
    bindHost: optional(env, 'BIND_HOST') ?? '0.0.0.0',
    dataPort: int(env, 'DATA_PORT', 8080),
    adminPort: int(env, 'ADMIN_PORT', 8081),
    adminUser: optional(env, 'ADMIN_USER') ?? 'admin',
    adminPasswordHash,
    adminPassword,
    sessionSecret,
    sessionTtlMs: int(env, 'SESSION_TTL_HOURS', 12) * 3_600_000,
    singleton: {
      disabled: bool(env, 'SINGLETON_DISABLED'),
      poolId: optional(env, 'SINGLETON_POOL') ?? 'proxyguard',
      heartbeatMs: int(env, 'SINGLETON_HEARTBEAT_SECONDS', 60) * 1000,
      staleMs: int(env, 'SINGLETON_STALE_SECONDS', 300) * 1000,
    },
    admission: {
      caps: {
        clone: int(env, 'ADMISSION_CLONE_CAP', 2),
        delete: int(env, 'ADMISSION_DELETE_CAP', 1),
        suspend: int(env, 'ADMISSION_SUSPEND_CAP', 1),
      },
      maxQueue: int(env, 'ADMISSION_MAX_QUEUE', 32),
      maxHoldMs: int(env, 'ADMISSION_MAX_HOLD_MS', 25_000),
      taskPollMs: int(env, 'ADMISSION_TASK_POLL_MS', 2_000),
      taskTimeoutMs: int(env, 'ADMISSION_TASK_TIMEOUT_MS', 600_000),
    },
    opsRingMax: int(env, 'OPS_RING_MAX', 20_000),
    instanceId: randomUUID(),
  }
}
