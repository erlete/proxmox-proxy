import { closeSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Db } from '../db.js'
import { log } from '../log.js'

/** Every SQLite database starts with this 16-byte magic. */
const SQLITE_MAGIC = 'SQLite format 3\u0000'

/** Tables a proxy database always has; their absence marks a foreign file. */
const REQUIRED_TABLES = ['api_keys', 'operations', 'meta', 'vlan_leases']

/**
 * Consistent online snapshot of the live database into a new file.
 * `VACUUM INTO` works under WAL without stopping writers, so a backup can be
 * taken from the panel while the proxy keeps serving. The caller streams the
 * file out and deletes it.
 */
export function createBackupSnapshot(db: Db, dataDir: string): string {
  const dir = dataDir === ':memory:' ? tmpdir() : dataDir
  const path = join(dir, `proxy-backup-${Date.now()}.db`)
  db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`)
  return path
}

const AUTO_DIR = 'backups'
const AUTO_PREFIX = 'auto-'
/** How often the auto-backup scheduler re-evaluates (not the snapshot rate). */
const AUTO_TICK_MS = 30 * 60_000
/** First evaluation shortly after boot, so fresh deploys get a snapshot. */
const AUTO_FIRST_TICK_MS = 60_000

/**
 * Rotating local snapshots: every `intervalHours` a `VACUUM INTO` lands in
 * `<dataDir>/backups/`, keeping the newest `keep` files. They live on the same
 * volume as the database, so they protect against corruption and operator
 * error, NOT against host loss; the off-host leg is the pull token (an
 * external cron downloading `/api/backup`). `keep = 0` disables. Returns a
 * stop function.
 */
export function startAutoBackup(
  db: Db,
  dataDir: string,
  getCfg: () => { intervalHours: number; keep: number },
): () => void {
  if (dataDir === ':memory:') return () => undefined
  const dir = join(dataDir, AUTO_DIR)

  const tick = (): void => {
    const { intervalHours, keep } = getCfg()
    if (keep <= 0) return
    try {
      mkdirSync(dir, { recursive: true })
      const autos = readdirSync(dir)
        .filter((f) => f.startsWith(AUTO_PREFIX) && f.endsWith('.db'))
        .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime)
      const newest = autos[0]
      if (newest && Date.now() - newest.mtime < intervalHours * 3_600_000) return
      const stamp = new Date().toISOString().slice(0, 19).replaceAll(':', '-')
      const path = join(dir, `${AUTO_PREFIX}${stamp}.db`)
      db.exec(`VACUUM INTO '${path.replaceAll("'", "''")}'`)
      log.info('auto backup snapshot written', { path })
      for (const old of autos.slice(Math.max(0, keep - 1))) {
        rmSync(join(dir, old.f), { force: true })
        log.info('auto backup pruned', { file: old.f })
      }
    } catch (err) {
      log.warn('auto backup failed', { error: String(err) })
    }
  }

  const first = setTimeout(tick, AUTO_FIRST_TICK_MS)
  first.unref()
  const timer = setInterval(tick, AUTO_TICK_MS)
  timer.unref()
  return () => {
    clearTimeout(first)
    clearInterval(timer)
  }
}

/**
 * Refuse anything that is not a proxy database BEFORE it can be staged as a
 * restore: SQLite magic first (cheap), then the schema fingerprint (opening
 * read-only cannot alter the uploaded file).
 */
export function validateBackupFile(path: string): void {
  const head = Buffer.alloc(16)
  const fd = openSync(path, 'r')
  try {
    readSync(fd, head, 0, 16, 0)
  } finally {
    closeSync(fd)
  }
  if (head.toString('latin1') !== SQLITE_MAGIC) {
    throw new Error('the uploaded file is not an SQLite database')
  }
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string
    }[]
    const names = new Set(rows.map((r) => String(r.name)))
    for (const table of REQUIRED_TABLES) {
      if (!names.has(table)) {
        throw new Error(`the uploaded file is not a proxy backup (missing table ${table})`)
      }
    }
  } finally {
    db.close()
  }
}
