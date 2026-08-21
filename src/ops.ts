import type { Db } from './db.js'

export interface OpRecord {
  keyName: string
  method: string
  path: string
  opClass: string | null
  vmid: number | null
  status: number | null
  queueMs: number | null
  durationMs: number | null
  upid: string | null
  note: string | null
}

export interface OpRow extends OpRecord {
  id: number
  ts: number
  taskMs: number | null
}

const PRUNE_EVERY = 500

/** Bounded operation log: recent history for the panel, not a metrics store. */
export class OpsLog {
  private inserts = 0

  constructor(
    private db: Db,
    private max: number,
  ) {}

  record(op: OpRecord): void {
    this.db
      .prepare(
        `INSERT INTO operations
           (ts, key_name, method, path, op_class, vmid, status, queue_ms, duration_ms, upid, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        Date.now(),
        op.keyName,
        op.method,
        op.path,
        op.opClass,
        op.vmid,
        op.status,
        op.queueMs,
        op.durationMs,
        op.upid,
        op.note,
      )
    this.inserts += 1
    if (this.inserts % PRUNE_EVERY === 0) this.prune()
  }

  finishTask(upid: string, exitstatus: string, taskMs: number): void {
    this.db
      .prepare('UPDATE operations SET note = ?, task_ms = ? WHERE upid = ?')
      .run(exitstatus, taskMs, upid)
  }

  list(filter: { limit?: number; opClass?: string; key?: string } = {}): OpRow[] {
    const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000)
    const where: string[] = []
    const params: (string | number)[] = []
    if (filter.opClass) {
      where.push('op_class = ?')
      params.push(filter.opClass)
    }
    if (filter.key) {
      where.push('key_name = ?')
      params.push(filter.key)
    }
    const sql = `SELECT * FROM operations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`
    const rows = this.db.prepare(sql).all(...params, limit) as Record<string, unknown>[]
    return rows.map((r) => ({
      id: Number(r.id),
      ts: Number(r.ts),
      keyName: String(r.key_name),
      method: String(r.method),
      path: String(r.path),
      opClass: r.op_class == null ? null : String(r.op_class),
      vmid: r.vmid == null ? null : Number(r.vmid),
      status: r.status == null ? null : Number(r.status),
      queueMs: r.queue_ms == null ? null : Number(r.queue_ms),
      durationMs: r.duration_ms == null ? null : Number(r.duration_ms),
      taskMs: r.task_ms == null ? null : Number(r.task_ms),
      upid: r.upid == null ? null : String(r.upid),
      note: r.note == null ? null : String(r.note),
    }))
  }

  private prune(): void {
    this.db
      .prepare(
        'DELETE FROM operations WHERE id <= (SELECT COALESCE(MAX(id), 0) FROM operations) - ?',
      )
      .run(this.max)
  }
}
