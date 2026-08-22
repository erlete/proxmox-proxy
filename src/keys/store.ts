import { createHash, randomUUID } from 'node:crypto'
import type { Db } from '../db.js'

export type VmidRange = [number, number]

export interface ApiKeyRecord {
  name: string
  vmidRanges: VmidRange[]
  comment: string
  enabled: boolean
  createdAt: number
  rotatedAt: number | null
  lastUsedAt: number | null
  prevValidUntil: number | null
}

interface CacheEntry {
  record: ApiKeyRecord
  secretHash: string
  prevSecretHash: string | null
}

const KEY_NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/
const LAST_USED_PERSIST_MS = 60_000

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export function vmidAllowed(ranges: VmidRange[], vmid: number): boolean {
  return ranges.some(([min, max]) => vmid >= min && vmid <= max)
}

/** True when any range in `a` overlaps any range in `b` (inclusive bounds). */
export function rangesOverlap(a: VmidRange[], b: VmidRange[]): boolean {
  return a.some(([a0, a1]) => b.some(([b0, b1]) => a0 <= b1 && b0 <= a1))
}

export function validRanges(ranges: unknown): ranges is VmidRange[] {
  if (!Array.isArray(ranges) || ranges.length === 0) return false
  return ranges.every(
    (r) =>
      Array.isArray(r) &&
      r.length === 2 &&
      Number.isInteger(r[0]) &&
      Number.isInteger(r[1]) &&
      r[0] >= 100 &&
      r[1] >= r[0] &&
      r[1] <= 999_999_999,
  )
}

export function validKeyName(name: string): boolean {
  return KEY_NAME_RE.test(name)
}

/**
 * Issued API keys. Secrets are stored hashed (SHA-256 is enough: secrets are
 * 128-bit random UUIDs, never human passwords). Verification runs on every
 * data-plane request, so the whole table is cached in memory.
 */
export class KeyStore {
  private cache = new Map<string, CacheEntry>()
  private lastUsedFlushed = new Map<string, number>()

  constructor(
    private db: Db,
    private tokenUser: string,
  ) {
    const rows = this.db.prepare('SELECT * FROM api_keys').all() as Record<string, unknown>[]
    for (const row of rows) this.cache.set(String(row.name), this.entryFromRow(row))
  }

  get user(): string {
    return this.tokenUser
  }

  private entryFromRow(row: Record<string, unknown>): CacheEntry {
    return {
      record: {
        name: String(row.name),
        vmidRanges: JSON.parse(String(row.vmid_ranges)) as VmidRange[],
        comment: String(row.comment ?? ''),
        enabled: Number(row.enabled) === 1,
        createdAt: Number(row.created_at),
        rotatedAt: row.rotated_at == null ? null : Number(row.rotated_at),
        lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
        prevValidUntil: row.prev_valid_until == null ? null : Number(row.prev_valid_until),
      },
      secretHash: String(row.secret_hash),
      prevSecretHash: row.prev_secret_hash == null ? null : String(row.prev_secret_hash),
    }
  }

  private fullToken(name: string, secret: string): string {
    return `PVEAPIToken=${this.tokenUser}!${name}=${secret}`
  }

  /** Returns the full token, shown exactly once. */
  create(name: string, vmidRanges: VmidRange[], comment = ''): string {
    if (!validKeyName(name)) throw new Error(`invalid key name: ${name}`)
    if (!validRanges(vmidRanges)) throw new Error('invalid vmid ranges')
    if (this.cache.has(name)) throw new Error(`key already exists: ${name}`)
    const secret = randomUUID()
    const now = Date.now()
    this.db
      .prepare(
        'INSERT INTO api_keys (name, secret_hash, vmid_ranges, comment, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)',
      )
      .run(name, sha256(secret), JSON.stringify(vmidRanges), comment, now)
    this.cache.set(name, {
      record: {
        name,
        vmidRanges,
        comment,
        enabled: true,
        createdAt: now,
        rotatedAt: null,
        lastUsedAt: null,
        prevValidUntil: null,
      },
      secretHash: sha256(secret),
      prevSecretHash: null,
    })
    return this.fullToken(name, secret)
  }

  /**
   * Rotate the secret. The previous secret stays valid for graceMs so the
   * consuming app can be migrated without downtime.
   */
  rotate(name: string, graceMs: number): string {
    const entry = this.cache.get(name)
    if (!entry || !entry.record.enabled) throw new Error(`unknown or revoked key: ${name}`)
    const secret = randomUUID()
    const now = Date.now()
    const prevValidUntil = graceMs > 0 ? now + graceMs : null
    this.db
      .prepare(
        'UPDATE api_keys SET prev_secret_hash = secret_hash, prev_valid_until = ?, secret_hash = ?, rotated_at = ? WHERE name = ?',
      )
      .run(prevValidUntil, sha256(secret), now, name)
    entry.prevSecretHash = prevValidUntil ? entry.secretHash : null
    entry.secretHash = sha256(secret)
    entry.record.rotatedAt = now
    entry.record.prevValidUntil = prevValidUntil
    return this.fullToken(name, secret)
  }

  /** Revocation is permanent: the name stays reserved, the key stops working. */
  revoke(name: string): boolean {
    const entry = this.cache.get(name)
    if (!entry) return false
    this.db.prepare('UPDATE api_keys SET enabled = 0 WHERE name = ?').run(name)
    entry.record.enabled = false
    return true
  }

  /**
   * Hard-delete the record and free the name for reuse. Only meant for an
   * already-revoked key: removing the trace of an app that no longer exists.
   */
  remove(name: string): boolean {
    if (!this.cache.has(name)) return false
    this.db.prepare('DELETE FROM api_keys WHERE name = ?').run(name)
    this.cache.delete(name)
    this.lastUsedFlushed.delete(name)
    return true
  }

  list(): ApiKeyRecord[] {
    return [...this.cache.values()]
      .map((e) => ({
        ...e.record,
        vmidRanges: e.record.vmidRanges.map((r) => [...r] as VmidRange),
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  get(name: string): ApiKeyRecord | null {
    const entry = this.cache.get(name)
    return entry ? { ...entry.record } : null
  }

  /** Hot path: in-memory only, plus a throttled last_used_at persist. */
  verify(tokenUser: string, name: string, secret: string): ApiKeyRecord | null {
    if (tokenUser !== this.tokenUser) return null
    const entry = this.cache.get(name)
    if (!entry || !entry.record.enabled) return null
    const hash = sha256(secret)
    const current = hash === entry.secretHash
    const previous =
      !current &&
      entry.prevSecretHash != null &&
      entry.record.prevValidUntil != null &&
      Date.now() < entry.record.prevValidUntil &&
      hash === entry.prevSecretHash
    if (!current && !previous) return null
    this.touch(name, entry)
    return entry.record
  }

  private touch(name: string, entry: CacheEntry): void {
    const now = Date.now()
    entry.record.lastUsedAt = now
    const flushed = this.lastUsedFlushed.get(name) ?? 0
    if (now - flushed >= LAST_USED_PERSIST_MS) {
      this.lastUsedFlushed.set(name, now)
      this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE name = ?').run(now, name)
    }
  }
}
