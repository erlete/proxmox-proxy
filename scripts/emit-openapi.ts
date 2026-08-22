import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildAdminServer } from '../src/admin/server.js'
import { Admission } from '../src/admission/queue.js'
import { loadConfig } from '../src/config.js'
import { openDb } from '../src/db.js'
import { KeyStore } from '../src/keys/store.js'
import { OpsLog } from '../src/ops.js'
import { SETTINGS_DEFAULTS, SettingsStore } from '../src/settings.js'
import type { Upstream } from '../src/upstream/client.js'
import type { HealthMonitor } from '../src/upstream/health.js'

// Builds the admin app against stub deps just to emit the OpenAPI document.
const config = loadConfig({
  PROXMOX_UPSTREAM_URL: 'https://127.0.0.1:1',
  PROXMOX_SERVICE_TOKEN: 'stub@pve!stub=00000000-0000-0000-0000-000000000000',
  ADMIN_PASSWORD: 'stub',
  SESSION_SECRET: 'stub',
  DATA_DIR: ':memory:',
  SINGLETON_DISABLED: 'true',
})

const db = openDb(':memory:')
const keys = new KeyStore(db, config.keysTokenUser)
const settings = new SettingsStore(db)
const ops = new OpsLog(db, () => SETTINGS_DEFAULTS.opsRingMax)
const admission = new Admission(null, {
  caps: {
    clone: SETTINGS_DEFAULTS.cloneCap,
    delete: SETTINGS_DEFAULTS.deleteCap,
    suspend: SETTINGS_DEFAULTS.suspendCap,
  },
  maxQueue: SETTINGS_DEFAULTS.maxQueue,
  maxHoldMs: SETTINGS_DEFAULTS.maxHoldMs,
  taskPollMs: SETTINGS_DEFAULTS.taskPollMs,
  taskTimeoutMs: SETTINGS_DEFAULTS.taskTimeoutMs,
  priorityApps: SETTINGS_DEFAULTS.priorityApps,
})
const health = { state: { ok: false, version: null, checkedAt: 0, error: null } } as HealthMonitor
const upstream = { api: () => Promise.resolve([]) } as unknown as Upstream

const app = await buildAdminServer({
  config,
  keys,
  settings,
  admission,
  health,
  ops,
  upstream,
  singletonHeld: () => false,
})
await app.ready()

const out = join(import.meta.dirname, '..', 'panel', 'openapi.json')
writeFileSync(out, JSON.stringify(app.swagger(), null, 2))
console.log(`OpenAPI written to ${out}`)
await app.close()
db.close()
