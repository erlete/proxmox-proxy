import { closeSync, openSync, readSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Db } from '../db.js'

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
