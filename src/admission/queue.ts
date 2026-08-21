import { EventEmitter } from 'node:events'
import { OP_CLASSES, type OpClassName } from '../config.js'
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

/**
 * Bounded admission per operation class. The key property: a slot is held
 * until the Proxmox TASK finishes, because the cluster cost of a clone or a
 * delete is the running task, not the HTTP request that spawned it.
 */
export class Admission extends EventEmitter {
  private nextId = 1
  private classes: Record<
    OpClassName,
    { cap: number; running: Map<number, Running>; waiting: Waiter[] }
  >
  private pollTimer: NodeJS.Timeout | null = null
  private changePending = false

  constructor(
    private upstream: Upstream | null,
    private opts: AdmissionOpts,
  ) {
    super()
    this.classes = {
      clone: { cap: opts.caps.clone, running: new Map(), waiting: [] },
      delete: { cap: opts.caps.delete, running: new Map(), waiting: [] },
      suspend: { cap: opts.caps.suspend, running: new Map(), waiting: [] },
    }
  }

  startTaskPoller(): void {
    this.pollTimer = setInterval(() => void this.pollTasks(), this.opts.taskPollMs)
    this.pollTimer.unref()
  }

  /** Hot-apply new limits (panel settings). Raised caps pump waiting requests. */
  applyOpts(opts: AdmissionOpts): void {
    const pollChanged = opts.taskPollMs !== this.opts.taskPollMs
    this.opts = opts
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
    for (const cls of OP_CLASSES) {
      for (const waiter of this.classes[cls].waiting) {
        clearTimeout(waiter.timer)
        waiter.reject(new HoldTimeoutError(5))
      }
      this.classes[cls].waiting = []
    }
  }

  acquire(meta: GrantMeta, signal?: AbortSignal): Promise<Grant> {
    const state = this.classes[meta.opClass]
    const enqueuedAt = Date.now()

    if (signal?.aborted) return Promise.reject(new ClientGoneError())

    if (state.running.size < state.cap && state.waiting.length === 0) {
      return Promise.resolve(this.grant(meta, enqueuedAt))
    }

    if (state.waiting.length >= this.opts.maxQueue) {
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
          this.removeWaiter(meta.opClass, id)
          reject(new HoldTimeoutError(this.retryAfterSec(meta.opClass)))
        }, this.opts.maxHoldMs),
        cleanup: () => signal?.removeEventListener('abort', onAbort),
      }
      const onAbort = (): void => {
        this.removeWaiter(meta.opClass, id)
        reject(new ClientGoneError())
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      state.waiting.push(waiter)
      this.changed()
    })
  }

  private removeWaiter(cls: OpClassName, id: number): void {
    const state = this.classes[cls]
    const idx = state.waiting.findIndex((w) => w.id === id)
    if (idx < 0) return
    const [waiter] = state.waiting.splice(idx, 1)
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
    this.pump(cls)
  }

  private pump(cls: OpClassName): void {
    const state = this.classes[cls]
    while (state.running.size < state.cap && state.waiting.length > 0) {
      const waiter = state.waiting.shift()
      if (!waiter) break
      clearTimeout(waiter.timer)
      waiter.cleanup()
      waiter.resolve(this.grant(waiter.meta, waiter.enqueuedAt))
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

  private retryAfterSec(cls: OpClassName): number {
    const state = this.classes[cls]
    return Math.max(5, Math.ceil(((state.waiting.length + 1) / Math.max(1, state.cap)) * 10))
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
    classes: {
      name: OpClassName
      cap: number
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
      classes: OP_CLASSES.map((name) => {
        const state = this.classes[name]
        return {
          name,
          cap: state.cap,
          running: [...state.running.values()].map((r) => ({
            id: r.id,
            keyName: r.keyName,
            vmid: r.vmid,
            node: r.node,
            upid: r.upid,
            grantedAt: r.grantedAt,
            taskStartedAt: r.taskStartedAt,
          })),
          waiting: state.waiting.map((w) => ({
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
