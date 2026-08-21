import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type Db = DatabaseSync

/**
 * Single durable store of the proxy: issued API keys and the bounded
 * operation log. Everything else is in-memory and reconstructable from
 * the cluster itself.
 */
export function openDb(dataDir: string): Db {
  let db: DatabaseSync
  if (dataDir === ':memory:') {
    db = new DatabaseSync(':memory:')
  } else {
    mkdirSync(dataDir, { recursive: true })
    db = new DatabaseSync(join(dataDir, 'proxy.db'))
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS api_keys (
      name TEXT PRIMARY KEY,
      secret_hash TEXT NOT NULL,
      prev_secret_hash TEXT,
      prev_valid_until INTEGER,
      vmid_ranges TEXT NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      rotated_at INTEGER,
      last_used_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS operations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      key_name TEXT NOT NULL,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      op_class TEXT,
      vmid INTEGER,
      status INTEGER,
      queue_ms INTEGER,
      duration_ms INTEGER,
      task_ms INTEGER,
      upid TEXT,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_operations_ts ON operations (ts);
    CREATE INDEX IF NOT EXISTS idx_operations_upid ON operations (upid);
  `)
  return db
}
