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
  /**
   * Stream guard: while a node has live consoles (running vncproxy-family
   * tasks), heavy ops on it run one at a time with `streamPacingMs` between
   * starts. With no console open, the caps apply untouched.
   */
  streamProtect: boolean
  streamPacingMs: number
  /** Rotating local snapshots in <dataDir>/backups; keep = 0 disables. */
  autoBackupIntervalHours: number
  autoBackupKeep: number
  /** Base URL apps use for direct VNC websockets. Empty = the upstream origin. */
  publicWsUrl: string
  /**
   * Admission priority per app (key name -> value, default 0). Higher value =
   * more preference; apps sort by value desc then name. Value 0 apps share the
   * bottom round-robin tier. Only non-zero values are stored.
   */
  appPriority: Record<string, number>
  /**
   * VMID ranges no app key may include. Enforced as configuration, not per
   * operation: a key whose ranges would overlap one of these is rejected, so an
   * app can never even name a reserved VMID (its own scope keeps it out). A
   * single VMID is a [n, n] range. Surfaced in the inventory.
   */
  reserved: VmidRange[]
  /**
   * 802.1q VLAN tag range [start, end] (inclusive) the proxy draws from when it
   * assigns an isolated VLAN to a linked-clone group. Null disables linked
   * cloning through the proxy. Must not collide with the platform's default
   * per-VM tags.
   */
  linkedVlanRange: [number, number] | null
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
  streamProtect: true,
  streamPacingMs: 1_000,
  autoBackupIntervalHours: 24,
  autoBackupKeep: 7,
  publicWsUrl: '',
  appPriority: {},
  reserved: [],
  linkedVlanRange: null,
}

const APP_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/
const PRIORITY_MAX = 1000
const VLAN_MIN = 1
const VLAN_MAX = 4094

const BOUNDS: Record<
  keyof Omit<
    Settings,
    'publicWsUrl' | 'appPriority' | 'reserved' | 'linkedVlanRange' | 'streamProtect'
  >,
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
  streamPacingMs: [0, 30_000],
  autoBackupIntervalHours: [1, 168],
  autoBackupKeep: [0, 60],
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
    // Deep-copy the mutable defaults so a missing stored field never aliases the
    // shared SETTINGS_DEFAULTS structures.
    this.values = {
      ...SETTINGS_DEFAULTS,
      ...stored,
      appPriority: { ...SETTINGS_DEFAULTS.appPriority, ...(stored.appPriority ?? {}) },
      reserved: (stored.reserved ?? SETTINGS_DEFAULTS.reserved).map((r) => [...r] as VmidRange),
      linkedVlanRange:
        (stored.linkedVlanRange ?? SETTINGS_DEFAULTS.linkedVlanRange)
          ? [
              (stored.linkedVlanRange ?? SETTINGS_DEFAULTS.linkedVlanRange)![0],
              (stored.linkedVlanRange ?? SETTINGS_DEFAULTS.linkedVlanRange)![1],
            ]
          : null,
    }
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
      linkedVlanRange: this.values.linkedVlanRange
        ? [this.values.linkedVlanRange[0], this.values.linkedVlanRange[1]]
        : null,
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
      } else if (key === 'streamProtect') {
        if (typeof value !== 'boolean') throw new Error('streamProtect must be a boolean')
        next.streamProtect = value
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
      } else if (key === 'linkedVlanRange') {
        next.linkedVlanRange = validateVlanRange(value)
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
    this.values = { ...SETTINGS_DEFAULTS, appPriority: {}, reserved: [], linkedVlanRange: null }
    setMeta(this.db, META_KEY, JSON.stringify(this.values))
    log.info('settings reset to defaults')
    this.emit('change', this.all)
    return this.all
  }
}

/** Validate a linked-VLAN range: null, or a [start, end] of tags 1..4094. */
function validateVlanRange(value: unknown): [number, number] | null {
  if (value === null) return null
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !Number.isInteger(value[0]) ||
    !Number.isInteger(value[1])
  ) {
    throw new Error('linkedVlanRange must be null or a [start, end] pair')
  }
  const [start, end] = value as [number, number]
  if (start < VLAN_MIN || end > VLAN_MAX || start > end) {
    throw new Error(
      `linkedVlanRange bounds must satisfy ${VLAN_MIN} <= start <= end <= ${VLAN_MAX}`,
    )
  }
  return [start, end]
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
