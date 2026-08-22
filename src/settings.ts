import { EventEmitter } from 'node:events'
import { getMeta, setMeta, type Db } from './db.js'
import { validRanges, type VmidRange } from './keys/store.js'
import { log } from './log.js'

/**
 * Runtime settings: everything an operator may want to tune while the proxy
 * runs. Managed from the panel, persisted in SQLite, applied hot. Boot-level
 * concerns (upstream, credentials, bind, singleton) stay in the environment.
 */
export interface Settings {
  cloneCap: number
  deleteCap: number
  suspendCap: number
  maxQueue: number
  maxHoldMs: number
  taskPollMs: number
  taskTimeoutMs: number
  opsRingMax: number
  sessionTtlHours: number
  /** Base URL apps use for direct VNC websockets. Empty = the upstream origin. */
  publicWsUrl: string
  /**
   * Admission priority per app (key name -> value, default 0). Higher value =
   * more preference; apps sort by value desc then name. Value 0 apps share the
   * bottom round-robin tier. Only non-zero values are stored.
   */
  appPriority: Record<string, number>
  /**
   * VMID ranges the proxy must NEVER touch, for ANY app: every operation that
   * targets a VMID inside these ranges is denied regardless of key scope. A
   * single VMID is a [n, n] range. Surfaced in the inventory.
   */
  reserved: VmidRange[]
}

export const SETTINGS_DEFAULTS: Settings = {
  cloneCap: 2,
  deleteCap: 1,
  suspendCap: 1,
  maxQueue: 32,
  maxHoldMs: 25_000,
  taskPollMs: 2_000,
  taskTimeoutMs: 600_000,
  opsRingMax: 20_000,
  sessionTtlHours: 12,
  publicWsUrl: '',
  appPriority: {},
  reserved: [],
}

const APP_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/
const PRIORITY_MAX = 1000

const BOUNDS: Record<
  keyof Omit<Settings, 'publicWsUrl' | 'appPriority' | 'reserved'>,
  [number, number]
> = {
  cloneCap: [0, 64],
  deleteCap: [0, 64],
  suspendCap: [0, 64],
  maxQueue: [0, 1000],
  maxHoldMs: [1_000, 120_000],
  taskPollMs: [250, 60_000],
  taskTimeoutMs: [10_000, 86_400_000],
  opsRingMax: [100, 1_000_000],
  sessionTtlHours: [1, 168],
}

const META_KEY = 'settings'

export class SettingsStore extends EventEmitter {
  private values: Settings

  constructor(private db: Db) {
    super()
    let stored: Partial<Settings> = {}
    try {
      stored = JSON.parse(getMeta(db, META_KEY) ?? '{}') as Partial<Settings>
    } catch {
      log.warn('stored settings unreadable, falling back to defaults')
    }
    this.values = { ...SETTINGS_DEFAULTS, ...stored }
  }

  /**
   * Reserved ranges for the data-plane hot path. Returns the live array (read
   * only): update() always replaces it wholesale, so it is a stable snapshot.
   */
  get reservedRanges(): VmidRange[] {
    return this.values.reserved
  }

  get all(): Settings {
    // Deep-copy the mutable structures so callers can never alter stored state.
    return {
      ...this.values,
      appPriority: { ...this.values.appPriority },
      reserved: this.values.reserved.map((r) => [...r] as VmidRange),
    }
  }

  /** Validates, persists and applies a partial update. Throws on bad values. */
  update(patch: Partial<Settings>): Settings {
    const next = { ...this.values }
    for (const [key, value] of Object.entries(patch) as [keyof Settings, unknown][]) {
      if (!(key in SETTINGS_DEFAULTS)) throw new Error(`unknown setting: ${key}`)
      if (key === 'publicWsUrl') {
        if (typeof value !== 'string' || value.length > 200) throw new Error('invalid publicWsUrl')
        if (value !== '') new URL(value) // throws when not a URL
        next.publicWsUrl = value
      } else if (key === 'appPriority') {
        next.appPriority = validatePriority(value)
      } else if (key === 'reserved') {
        if (
          !Array.isArray(value) ||
          value.length > 128 ||
          (value.length > 0 && !validRanges(value))
        ) {
          throw new Error('invalid reserved ranges')
        }
        next.reserved = (value as VmidRange[]).map((r) => [...r] as VmidRange)
      } else {
        const [min, max] = BOUNDS[key]
        if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
          throw new Error(`setting ${key} must be a number between ${min} and ${max}`)
        }
        next[key] = Math.round(value)
      }
    }
    this.values = next
    setMeta(this.db, META_KEY, JSON.stringify(this.values))
    log.info('settings updated', { keys: Object.keys(patch) })
    this.emit('change', this.all)
    return this.all
  }

  reset(): Settings {
    this.values = { ...SETTINGS_DEFAULTS, appPriority: {}, reserved: [] }
    setMeta(this.db, META_KEY, JSON.stringify(this.values))
    log.info('settings reset to defaults')
    this.emit('change', this.all)
    return this.all
  }
}

/** Validate an app-priority map: valid names, integer 0..PRIORITY_MAX; drop 0s. */
function validatePriority(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid appPriority')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 128) throw new Error('too many appPriority entries')
  const out: Record<string, number> = {}
  for (const [name, v] of entries) {
    if (!APP_NAME_RE.test(name)) throw new Error(`invalid app name in appPriority: ${name}`)
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > PRIORITY_MAX) {
      throw new Error(`priority for ${name} must be an integer between 0 and ${PRIORITY_MAX}`)
    }
    if (v > 0) out[name] = v // 0 is the default; do not persist it
  }
  return out
}
