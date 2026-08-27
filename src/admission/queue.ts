import { EventEmitter } from 'node:events'
import { OP_CLASSES, type OpClassName } from '../config.js'
import { vmidAllowed, type VmidRange } from '../keys/store.js'
import { log } from '../log.js'
import type { Upstream } from '../upstream/client.js'

export interface GrantMeta {
  opClass: OpClassName
  keyName: string
  vmid: number | null
  node: string | null
}

export interface Grant {
  id: number
  queueMs: number
  /** Hold the slot until the referenced Proxmox task stops. */
  attachTask(upid: string): void
  /** Release immediately (forward failed, no task was spawned). */
  release(note?: string): void
}

interface Running extends GrantMeta {
  id: number
  grantedAt: number
  upid: string | null
  taskStartedAt: number | null
  pollErrors: number
}

interface Waiter {
  id: number
  meta: GrantMeta
  enqueuedAt: number
  resolve: (grant: Grant) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  cleanup: () => void
}

export class QueueFullError extends Error {
  constructor(public readonly retryAfterSec: number) {
    super('admission queue full')
    this.name = 'QueueFullError'
  }
}

export class HoldTimeoutError extends Error {
  constructor(public readonly retryAfterSec: number) {
    super('no admission slot within the hold budget')
    this.name = 'HoldTimeoutError'
  }
}

export class ClientGoneError extends Error {
  constructor() {
    super('client disconnected while queued')
    this.name = 'ClientGoneError'
  }
}

export interface AdmissionOpts {
  caps: Record<OpClassName, number>
  maxQueue: number
  maxHoldMs: number
  taskPollMs: number
  taskTimeoutMs: number
  /**
   * Ordered app (key) names that get preference when a slot frees. Each listed
   * app is its own strict tier in list order; every unlisted app shares the
   * bottom tier and is served round-robin. Empty = pure round-robin fairness.
   */
  priorityApps: string[]
  /**
   * Stream guard: while a node has LIVE consoles (running vncproxy-family
   * tasks, seen in the same cluster task poll as the out-of-band discount),
   * heavy ops on that node run one at a time with `streamPacingMs` between
   * starts. With no console open, the configured caps apply untouched: the
   * only window that matters for stream quality is when someone is watching.
   */
  streamProtect: boolean
  streamPacingMs: number
  /**
   * Reserved vmid ranges (mirrored from settings). A console on a reserved
   * vmid is operator work (an infra VM viewed from the Proxmox UI), not a
   * broadcast, so it never engages the stream guard.
   */
  reservedRanges: VmidRange[]
}

export interface TaskFinishedEvent {
  upid: string
  exitstatus: string | null
  taskMs: number
  note: string
}

interface TaskStatus {
  status: string
  exitstatus?: string
}

/** Shape of an entry in the cluster-wide task list (`GET /cluster/tasks`). */
interface ClusterTask {
  upid: string
  type: string
  node?: string
  /** Task subject: the vmid as a string for guest tasks, empty for node ones. */
  id?: string
  /** Present only once the task has finished. */
  endtime?: number
}

/**
 * Task types that mean "someone is looking at a console right now". A console
 * task stays RUNNING for exactly as long as its websocket lives (verified live:
 * visible within ~2s of the socket opening, gone within ~1s of it closing), so
 * the cluster task list is ground truth for live viewers, including ones that
 * never touched this proxy (Proxmox UI, platforms not yet migrated).
 */
const CONSOLE_TASK_TYPES = new Set(['vncproxy', 'vncshell', 'termproxy', 'spiceproxy'])

/**
 * Proxmox worker task types that map to a contended admission class.
 *
 * `vncproxy` is deliberately absent: a console task stays alive for the whole
 * session (minutes to hours) yet costs no pool I/O, so it must never consume a
 * clone/delete/suspend slot. The proxy is what forces this distinction, so the
 * backstop below has to make it explicit.
 */
const TASK_TYPE_CLASS: Record<string, OpClassName> = {
  qmclone: 'clone',
  qmdestroy: 'delete',
  qmsuspend: 'suspend',
}

interface ClassState {
  cap: number
  running: Map<number, Running>
  /**
   * Waiters split into one FIFO sub-queue per app (key name). Scheduling picks
   * across apps for fairness; order WITHIN an app stays first-in-first-out.
   */
  waiting: Map<string, Waiter[]>
}

/**
 * Bounded admission per operation class. Two key properties:
 *   - a slot is held until the Proxmox TASK finishes, because the cluster cost
 *     of a clone or a delete is the running task, not the HTTP request; and
 *   - capacity is shared fairly across apps (max-min, work-conserving): one app
 *     may use the whole class while alone, but as other apps start contending
 *     the freed slots rotate to them, so no app monopolizes ordering. A manual
 *     priority list can override the rotation with strict tiers.
 */
export class Admission extends EventEmitter {
  private nextId = 1
  private classes: Record<OpClassName, ClassState>
  private pollTimer: NodeJS.Timeout | null = null
  private changePending = false
  /** Contended cluster load that did NOT pass through the proxy (backstop). */
  private outOfBand: Record<OpClassName, number> = { clone: 0, delete: 0, suspend: 0, power: 0 }
  private obPollErrors = 0
  private priorityApps: string[]
  /** Last app served from the bottom (round-robin) tier, per class. */
  private rrCursor: Record<OpClassName, string> = { clone: '', delete: '', suspend: '', power: '' }
  /** Live consoles per node, from the same cluster task poll as out-of-band. */
  private consoleNodes = new Map<string, number>()
  /** Last heavy-op grant per node, the anchor for stream pacing. */
  private lastHeavyStart = new Map<string, number>()
  /** Pending re-pump for a time-blocked (paced) waiter. */
  private pacingTimer: NodeJS.Timeout | null = null

  constructor(
    private upstream: Upstream | null,
    private opts: AdmissionOpts,
  ) {
    super()
    this.priorityApps = opts.priorityApps
    this.classes = {
      clone: { cap: opts.caps.clone, running: new Map(), waiting: new Map() },
      delete: { cap: opts.caps.delete, running: new Map(), waiting: new Map() },
      suspend: { cap: opts.caps.suspend, running: new Map(), waiting: new Map() },
      power: { cap: opts.caps.power, running: new Map(), waiting: new Map() },
    }
  }

  startTaskPoller(): void {
    this.pollTimer = setInterval(() => {
      void this.pollTasks()
      void this.pollOutOfBand()
    }, this.opts.taskPollMs)
    this.pollTimer.unref()
  }

  /**
   * Effective cap for a class: the configured cap minus the contended load the
   * cluster is already running outside the proxy. Clamped at zero, so heavy
   * out-of-band activity holds admission back entirely until it clears.
   */
  private effectiveCap(cls: OpClassName): number {
    return Math.max(0, this.classes[cls].cap - this.outOfBand[cls])
  }

  private countWaiting(cls: OpClassName): number {
    let n = 0
    for (const q of this.classes[cls].waiting.values()) n += q.length
    return n
  }

  /** Ops of the given classes currently holding a slot on this node. */
  private runningOn(node: string, classes: readonly OpClassName[]): number {
    let n = 0
    for (const cls of classes) {
      for (const r of this.classes[cls].running.values()) if (r.node === node) n += 1
    }
    return n
  }

  /**
   * Stream guard verdict for a candidate grant: `null` = free to start now;
   * `Infinity` = blocked until a running op on the node finishes (finish()
   * re-pumps); a timestamp = paced, allowed from that instant (a timer re-pumps).
   * The guard only ever serializes and paces, it never denies: with no console
   * open on the node the caps rule alone, which is the whole point.
   *
   * Asymmetry by design: a POWER op is interactive (a participant pressing
   * start), so it serializes only against other power ops and never waits out
   * a long clone or delete task; heavy ops yield to EVERYTHING, power
   * included. Both share the pacing anchor, so a stop right after a clone
   * start still leaves the node a breath between kicks.
   */
  private guardBlockedUntil(meta: GrantMeta): number | null {
    if (!this.opts.streamProtect || meta.node == null) return null
    if ((this.consoleNodes.get(meta.node) ?? 0) === 0) return null
    const blockers =
      meta.opClass === 'power'
        ? this.runningOn(meta.node, ['power'])
        : this.runningOn(meta.node, OP_CLASSES)
    if (blockers > 0) return Infinity
    const at = (this.lastHeavyStart.get(meta.node) ?? 0) + this.opts.streamPacingMs
    return Date.now() >= at ? null : at
  }

  private pacingAt = Infinity

  /** Re-pump every class at (or shortly after) the given instant. */
  private scheduleRepump(at: number): void {
    if (this.pacingTimer) {
      if (at >= this.pacingAt) return // an earlier or equal wake-up is already set
      clearTimeout(this.pacingTimer)
    }
    this.pacingAt = at
    this.pacingTimer = setTimeout(
      () => {
        this.pacingTimer = null
        this.pacingAt = Infinity
        for (const cls of OP_CLASSES) this.pump(cls)
      },
      Math.max(0, at - Date.now()) + 5,
    )
    this.pacingTimer.unref()
  }

  /**
   * Pick the app whose waiter should be granted next: the first app on the
   * priority list that has a waiter (strict tiers, in list order), otherwise
   * the next unlisted app in a stable round-robin rotation.
   */
  private pickWaiterApp(cls: OpClassName): string | null {
    const state = this.classes[cls]
    for (const name of this.priorityApps) {
      if (state.waiting.get(name)?.length) return name
    }
    const rest = [...state.waiting.keys()]
      .filter((a) => state.waiting.get(a)!.length > 0 && !this.priorityApps.includes(a))
      .sort()
    if (rest.length === 0) return null
    const cursor = this.rrCursor[cls]
    const next = rest.find((a) => a > cursor) ?? rest[0]
    this.rrCursor[cls] = next
    return next
  }

  /** Hot-apply new limits and priority (panel settings). */
  applyOpts(opts: AdmissionOpts): void {
    const pollChanged = opts.taskPollMs !== this.opts.taskPollMs
    this.opts = opts
    this.priorityApps = opts.priorityApps
    for (const cls of OP_CLASSES) {
      this.classes[cls].cap = opts.caps[cls]
      this.pump(cls)
    }
    if (pollChanged && this.pollTimer) {
      clearInterval(this.pollTimer)
      this.startTaskPoller()
    }
    this.changed()
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.pacingTimer) clearTimeout(this.pacingTimer)
    for (const cls of OP_CLASSES) {
      for (const q of this.classes[cls].waiting.values()) {
        for (const waiter of q) {
          clearTimeout(waiter.timer)
          waiter.reject(new HoldTimeoutError(5))
        }
      }
      this.classes[cls].waiting.clear()
    }
  }

  acquire(meta: GrantMeta, signal?: AbortSignal): Promise<Grant> {
    const state = this.classes[meta.opClass]
    const enqueuedAt = Date.now()

    if (signal?.aborted) return Promise.reject(new ClientGoneError())

    const waiting = this.countWaiting(meta.opClass)
    if (
      state.running.size < this.effectiveCap(meta.opClass) &&
      waiting === 0 &&
      this.guardBlockedUntil(meta) === null
    ) {
      return Promise.resolve(this.grant(meta, enqueuedAt))
    }

    if (waiting >= this.opts.maxQueue) {
      return Promise.reject(new QueueFullError(this.retryAfterSec(meta.opClass)))
    }

    return new Promise<Grant>((resolve, reject) => {
      const id = this.nextId++
      const waiter: Waiter = {
        id,
        meta,
        enqueuedAt,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(meta.opClass, meta.keyName, id)
          reject(new HoldTimeoutError(this.retryAfterSec(meta.opClass)))
        }, this.opts.maxHoldMs),
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      }
      const onAbort = (): void => {
        this.removeWaiter(meta.opClass, meta.keyName, id)
        reject(new ClientGoneError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const q = state.waiting.get(meta.keyName)
      if (q) q.push(waiter)
      else state.waiting.set(meta.keyName, [waiter])
      this.changed()
      // A guard-paced waiter has capacity but must wait for a timestamp; make
      // sure something wakes the pump then (finish() covers the running case).
      const blocked = this.guardBlockedUntil(meta)
      if (blocked !== null && blocked !== Infinity) this.scheduleRepump(blocked)
    })
  }

  private removeWaiter(cls: OpClassName, app: string, id: number): void {
    const q = this.classes[cls].waiting.get(app)
    if (!q) return
    const idx = q.findIndex((w) => w.id === id)
    if (idx < 0) return
    const [waiter] = q.splice(idx, 1)
    if (q.length === 0) this.classes[cls].waiting.delete(app)
    clearTimeout(waiter.timer)
    waiter.cleanup()
    this.changed()
  }

  private grant(meta: GrantMeta, enqueuedAt: number): Grant {
    const id = this.nextId++
    const running: Running = {
      ...meta,
      id,
      grantedAt: Date.now(),
      upid: null,
      taskStartedAt: null,
      pollErrors: 0,
    }
    this.classes[meta.opClass].running.set(id, running)
    // Pacing anchor, recorded unconditionally: a console that opens mid-burst
    // must inherit the spacing from the burst's last start, not reset it.
    if (meta.node != null) this.lastHeavyStart.set(meta.node, Date.now())
    this.changed()
    let done = false
    return {
      id,
      queueMs: Date.now() - enqueuedAt,
      attachTask: (upid: string) => {
        running.upid = upid
        running.taskStartedAt = Date.now()
        this.changed()
      },
      release: (note?: string) => {
        if (done || running.upid) return
        done = true
        this.finish(meta.opClass, id, note ?? 'released')
      },
    }
  }

  private finish(cls: OpClassName, id: number, note: string): void {
    const state = this.classes[cls]
    const running = state.running.get(id)
    if (!running) return
    state.running.delete(id)
    if (running.upid && running.taskStartedAt) {
      this.emit('task-finished', {
        upid: running.upid,
        exitstatus: note,
        taskMs: Date.now() - running.taskStartedAt,
        note,
      } satisfies TaskFinishedEvent)
    }
    this.changed()
    // Pump EVERY class: under the stream guard a finishing delete can be what
    // unblocks a waiting clone on the same node, across class lines.
    for (const c of OP_CLASSES) this.pump(c)
  }

  private pump(cls: OpClassName): void {
    const state = this.classes[cls]
    while (state.running.size < this.effectiveCap(cls)) {
      const app = this.pickWaiterApp(cls)
      if (!app) break
      const q = state.waiting.get(app)!
      // Peek before shifting: a guard-blocked head stays first in line. On a
      // multi-node cluster this can hold the class behind one guarded node's
      // waiter; accepted for now (the real deployment is single-node) and the
      // guard never blocks forever: a finish or the pacing timer re-pumps.
      const head = q[0]
      const blocked = this.guardBlockedUntil(head.meta)
      if (blocked !== null) {
        if (blocked !== Infinity) this.scheduleRepump(blocked)
        break
      }
      q.shift()
      if (q.length === 0) state.waiting.delete(app)
      clearTimeout(head.timer)
      head.cleanup()
      head.resolve(this.grant(head.meta, head.enqueuedAt))
    }
  }

  private async pollTasks(): Promise<void> {
    if (!this.upstream) return
    for (const cls of OP_CLASSES) {
      for (const running of [...this.classes[cls].running.values()]) {
        if (!running.upid || !running.taskStartedAt || !running.node) continue
        const elapsed = Date.now() - running.taskStartedAt
        try {
          const status = await this.upstream.api<TaskStatus>(
            'GET',
            `/nodes/${running.node}/tasks/${encodeURIComponent(running.upid)}/status`,
          )
          running.pollErrors = 0
          if (status.status === 'stopped') {
            this.finish(cls, running.id, status.exitstatus ?? 'stopped')
          } else if (elapsed > this.opts.taskTimeoutMs) {
            log.warn('task exceeded the safety timeout, releasing its slot', {
              upid: running.upid,
            })
            this.finish(cls, running.id, 'timeout')
          }
        } catch (err) {
          running.pollErrors += 1
          // Bias to non-obstruction: a slot must never wedge on poll errors.
          if (running.pollErrors >= 5 && elapsed > 60_000) {
            log.warn('releasing slot after repeated task poll errors', {
              upid: running.upid,
              error: String(err),
            })
            this.finish(cls, running.id, 'poll-error')
          }
        }
      }
    }
  }

  /**
   * Backstop: discount out-of-band cluster load from the caps. Not everything
   * that runs on the cluster passes through the proxy (manual actions in the
   * Proxmox UI, platforms not yet migrated behind it), so the proxy polls the
   * cluster task list and subtracts the contended tasks it did not itself
   * admit. Console (vncproxy) tasks are excluded on purpose (see
   * TASK_TYPE_CLASS): they are long-lived but cost no pool I/O.
   */
  private async pollOutOfBand(): Promise<void> {
    if (!this.upstream) return
    try {
      const tasks = await this.upstream.api<ClusterTask[]>('GET', '/cluster/tasks')
      const ours = new Set<string>()
      for (const cls of OP_CLASSES) {
        for (const r of this.classes[cls].running.values()) if (r.upid) ours.add(r.upid)
      }
      const counts: Record<OpClassName, number> = { clone: 0, delete: 0, suspend: 0, power: 0 }
      const consoles = new Map<string, number>()
      for (const t of tasks) {
        if (t.endtime) continue // finished, no longer contending
        // Live console (vncproxy family): the stream-guard signal. Counted for
        // every task source, so viewers that bypass the proxy still protect.
        // Reserved vmids are the exception: those consoles are the operator
        // looking at infra, and must not hold app operations back.
        if (CONSOLE_TASK_TYPES.has(t.type) && t.node) {
          const vmid = Number(t.id)
          if (!(Number.isInteger(vmid) && vmidAllowed(this.opts.reservedRanges, vmid))) {
            consoles.set(t.node, (consoles.get(t.node) ?? 0) + 1)
          }
          continue
        }
        const cls = TASK_TYPE_CLASS[t.type]
        if (!cls) continue // not a contended class
        if (ours.has(t.upid)) continue // already counted in our own running set
        counts[cls] += 1
      }
      this.setConsoleNodes(consoles)
      // A just-granted op is visible in the cluster list before its UPID is
      // attached locally (attachTask runs only after the upstream round-trip),
      // so it would otherwise be counted as out-of-band while also occupying a
      // running slot: a double-count that over-throttles. Discount our own
      // UPID-less grants per class. Biased to non-obstruction.
      for (const cls of OP_CLASSES) {
        let pending = 0
        for (const r of this.classes[cls].running.values()) if (!r.upid) pending += 1
        counts[cls] = Math.max(0, counts[cls] - pending)
      }
      this.obPollErrors = 0
      this.setOutOfBand(counts)
    } catch (err) {
      // Bias to non-obstruction: if we cannot see the cluster we must not block
      // legitimate apps. Decay the discount to zero after a few misses rather
      // than freezing a stale value that would keep obstructing. The console
      // map decays with it: better to briefly stop guarding than to serialize
      // an app behind a console that may have closed long ago.
      this.obPollErrors += 1
      if (this.obPollErrors >= 3) {
        this.setOutOfBand({ clone: 0, delete: 0, suspend: 0, power: 0 })
        this.setConsoleNodes(new Map())
      }
      if (this.obPollErrors <= 3 || this.obPollErrors % 10 === 0) {
        log.warn('out-of-band task poll failed', {
          failures: this.obPollErrors,
          error: String(err),
        })
      }
    }
  }

  private setOutOfBand(next: Record<OpClassName, number>): void {
    let dropped = false
    for (const cls of OP_CLASSES) {
      if (next[cls] < this.outOfBand[cls]) dropped = true
      this.outOfBand[cls] = next[cls]
    }
    // A drop frees effective capacity: pump any classes that can now run.
    if (dropped) for (const cls of OP_CLASSES) this.pump(cls)
    this.changed()
  }

  private setConsoleNodes(next: Map<string, number>): void {
    let changed = next.size !== this.consoleNodes.size
    if (!changed) {
      for (const [node, n] of next) {
        if (this.consoleNodes.get(node) !== n) {
          changed = true
          break
        }
      }
    }
    if (!changed) return
    this.consoleNodes = next
    // Fewer (or no) consoles may lift the guard for queued waiters: pump.
    for (const cls of OP_CLASSES) this.pump(cls)
    this.changed()
  }

  private retryAfterSec(cls: OpClassName): number {
    const state = this.classes[cls]
    return Math.max(5, Math.ceil(((this.countWaiting(cls) + 1) / Math.max(1, state.cap)) * 10))
  }

  /** Waiters flattened in the order they will be served (for the panel). */
  private orderedWaiters(cls: OpClassName): Waiter[] {
    const state = this.classes[cls]
    const out: Waiter[] = []
    for (const name of this.priorityApps) {
      const q = state.waiting.get(name)
      if (q?.length) out.push(...q)
    }
    const rest = [...state.waiting.keys()].filter((a) => !this.priorityApps.includes(a)).sort()
    for (const name of rest) out.push(...state.waiting.get(name)!)
    return out
  }

  /** Throttled change notification for SSE consumers. */
  private changed(): void {
    if (this.changePending) return
    this.changePending = true
    setTimeout(() => {
      this.changePending = false
      this.emit('change', this.snapshot())
    }, 200).unref()
  }

  snapshot(): {
    priorityApps: string[]
    streamProtect: boolean
    streamPacingMs: number
    /** Live consoles per node; a node listed here has the guard engaged. */
    consoles: { node: string; count: number }[]
    classes: {
      name: OpClassName
      cap: number
      outOfBand: number
      effectiveCap: number
      running: {
        id: number
        keyName: string
        vmid: number | null
        node: string | null
        upid: string | null
        grantedAt: number
        taskStartedAt: number | null
      }[]
      waiting: { id: number; keyName: string; vmid: number | null; enqueuedAt: number }[]
    }[]
  } {
    return {
      priorityApps: [...this.priorityApps],
      streamProtect: this.opts.streamProtect,
      streamPacingMs: this.opts.streamPacingMs,
      consoles: [...this.consoleNodes.entries()]
        .map(([node, count]) => ({ node, count }))
        .sort((a, b) => a.node.localeCompare(b.node)),
      classes: OP_CLASSES.map((name) => {
        const state = this.classes[name]
        return {
          name,
          cap: state.cap,
          outOfBand: this.outOfBand[name],
          effectiveCap: this.effectiveCap(name),
          running: [...state.running.values()].map((r) => ({
            id: r.id,
            keyName: r.keyName,
            vmid: r.vmid,
            node: r.node,
            upid: r.upid,
            grantedAt: r.grantedAt,
            taskStartedAt: r.taskStartedAt,
          })),
          waiting: this.orderedWaiters(name).map((w) => ({
            id: w.id,
            keyName: w.meta.keyName,
            vmid: w.meta.vmid,
            enqueuedAt: w.enqueuedAt,
          })),
        }
      }),
    }
  }
}
