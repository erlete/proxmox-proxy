import { EventEmitter } from 'node:events'
import { getMeta, setMeta, type Db } from './db.js'
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
}

const BOUNDS: Record<keyof Omit<Settings, 'publicWsUrl'>, [number, number]> = {
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

  get all(): Settings {
    return { ...this.values }
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
      } else {
        const [min, max] = BOUNDS[key]
        if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
          throw new Error(`setting ${key} must be a number between ${min} and ${max}`)
        }
        next[key] = Math.round(value)
      }
    }
    const changed = Object.keys(patch).filter(
      (k) => this.values[k as keyof Settings] !== next[k as keyof Settings],
    )
    this.values = next
    setMeta(this.db, META_KEY, JSON.stringify(this.values))
    if (changed.length > 0) {
      log.info('settings updated', Object.fromEntries(changed.map((k) => [k, next[k as keyof Settings]])))
      this.emit('change', this.all)
    }
    return this.all
  }

  reset(): Settings {
    this.values = { ...SETTINGS_DEFAULTS }
    setMeta(this.db, META_KEY, JSON.stringify(this.values))
    log.info('settings reset to defaults')
    this.emit('change', this.all)
    return this.all
  }
}
