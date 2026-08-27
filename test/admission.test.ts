import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  Admission,
  HoldTimeoutError,
  QueueFullError,
  type Grant,
  type GrantMeta,
} from '../src/admission/queue.js'
import type { Upstream } from '../src/upstream/client.js'

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10))

/** Force one backstop poll on demand (the method is otherwise interval-driven). */
const pollOutOfBand = (a: Admission): Promise<void> =>
  (a as unknown as { pollOutOfBand(): Promise<void> }).pollOutOfBand()

const meta = (keyName = 'app-a'): GrantMeta => ({
  opClass: 'clone',
  keyName,
  vmid: 1100100,
  node: 'n1',
})

function build(
  overrides: Partial<{
    cloneCap: number
    maxQueue: number
    maxHoldMs: number
    priorityApps: string[]
  }> = {},
): Admission {
  return new Admission(null, {
    caps: { clone: overrides.cloneCap ?? 1, delete: 1, suspend: 1, power: 64 },
    maxQueue: overrides.maxQueue ?? 8,
    maxHoldMs: overrides.maxHoldMs ?? 200,
    taskPollMs: 1_000_000,
    taskTimeoutMs: 1_000_000,
    priorityApps: overrides.priorityApps ?? [],
    streamProtect: true,
    streamPacingMs: 0,
    reservedRanges: [],
  })
}

test('grants immediately while under the cap', async () => {
  const admission = build({ cloneCap: 2 })
  const a = await admission.acquire(meta())
  const b = await admission.acquire(meta())
  assert.equal(admission.snapshot().classes.find((c) => c.name === 'clone')?.running.length, 2)
  a.release()
  b.release()
})

test('queues above the cap and pumps on release', async () => {
  const admission = build()
  const first = await admission.acquire(meta())
  const second = admission.acquire(meta('app-b'))
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(admission.snapshot().classes.find((c) => c.name === 'clone')?.waiting.length, 1)
  first.release()
  const grant = await second
  assert.ok(grant.queueMs >= 0)
  grant.release()
})

test('overflows with 429 semantics when the queue is full', async () => {
  const admission = build({ maxQueue: 1 })
  const first = await admission.acquire(meta())
  const waitingPromise = admission.acquire(meta('app-b'))
  waitingPromise.catch(() => {})
  await new Promise((r) => setTimeout(r, 20))
  await assert.rejects(admission.acquire(meta('app-c')), QueueFullError)
  first.release()
  ;(await waitingPromise).release()
})

test('waiting requests time out within the hold budget', async () => {
  const admission = build({ maxHoldMs: 50 })
  const first = await admission.acquire(meta())
  await assert.rejects(admission.acquire(meta('app-b')), HoldTimeoutError)
  first.release()
})

test('client abort removes the waiter', async () => {
  const admission = build()
  const first = await admission.acquire(meta())
  const abort = new AbortController()
  const waiting = admission.acquire(meta('app-b'), abort.signal)
  waiting.catch(() => {})
  await new Promise((r) => setTimeout(r, 20))
  abort.abort()
  await assert.rejects(waiting)
  assert.equal(admission.snapshot().classes.find((c) => c.name === 'clone')?.waiting.length, 0)
  first.release()
})

test('a released grant with an attached task stays held', async () => {
  const admission = build()
  const grant = await admission.acquire(meta())
  grant.attachTask('UPID:n1:0:0:0:qmclone:1100100:root@pam:')
  grant.release() // must be a no-op: the task poller owns the slot now
  assert.equal(admission.snapshot().classes.find((c) => c.name === 'clone')?.running.length, 1)
})

test('backstop discounts out-of-band cluster load and excludes vncproxy', async () => {
  const tasks = [
    { upid: 'UPID:n1:1:1:1:qmclone:200:root@pam:', type: 'qmclone' }, // out-of-band, running
    { upid: 'UPID:n1:2:2:2:vncproxy:300:root@pam:', type: 'vncproxy' }, // console: never counts
    { upid: 'UPID:n1:3:3:3:qmclone:400:root@pam:', type: 'qmclone', endtime: 9 }, // finished
  ]
  const upstream = { api: () => Promise.resolve(tasks) } as unknown as Upstream
  const admission = new Admission(upstream, {
    caps: { clone: 2, delete: 1, suspend: 1 },
    maxQueue: 2,
    maxHoldMs: 200,
    taskPollMs: 1_000_000,
    taskTimeoutMs: 1_000_000,
    priorityApps: [],
    reservedRanges: [],
  })
  await pollOutOfBand(admission)

  const clone = admission.snapshot().classes.find((c) => c.name === 'clone')
  assert.equal(clone?.outOfBand, 1) // only the running qmclone that is not ours
  assert.equal(clone?.effectiveCap, 1) // cap 2 minus 1 out-of-band

  // Effective cap 1: the first grant fills it, the second must queue.
  const a = await admission.acquire(meta())
  const bPromise = admission.acquire(meta('b'))
  bPromise.catch(() => {})
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(admission.snapshot().classes.find((c) => c.name === 'clone')?.waiting.length, 1)
  a.release()
  ;(await bPromise).release()
})

test('backstop decays the discount to zero when the cluster is unreadable', async () => {
  const upstream = {
    api: () => Promise.reject(new Error('cluster unreadable')),
  } as unknown as Upstream
  const admission = new Admission(upstream, {
    caps: { clone: 1, delete: 1, suspend: 1 },
    maxQueue: 2,
    maxHoldMs: 200,
    taskPollMs: 1_000_000,
    taskTimeoutMs: 1_000_000,
    priorityApps: [],
    reservedRanges: [],
  })
  // Seed a stale discount, then confirm repeated read failures decay it away:
  // an unreadable cluster must never keep obstructing legitimate apps.
  ;(admission as unknown as { outOfBand: Record<string, number> }).outOfBand.clone = 5
  await pollOutOfBand(admission)
  await pollOutOfBand(admission)
  await pollOutOfBand(admission)
  assert.equal(admission.snapshot().classes.find((c) => c.name === 'clone')?.outOfBand, 0)
})

test('fairness: freed slots rotate round-robin across apps, not FIFO by arrival', async () => {
  // cap 1. app-a holds the slot and queues two more; app-b queues one AFTER.
  // FIFO would serve a1, a2, b1. Round-robin must interleave: a1, b1, a2.
  const admission = build({ cloneCap: 1 })
  const running = await admission.acquire(meta('app-a'))
  const order: string[] = []
  const resolved: Grant[] = []
  const enq = (app: string): void => {
    admission
      .acquire(meta(app))
      .then((g) => {
        order.push(app)
        resolved.push(g)
      })
      .catch(() => {})
  }
  enq('app-a')
  enq('app-a')
  await tick()
  enq('app-b')
  await tick()

  running.release()
  await tick()
  assert.deepEqual(order, ['app-a'])
  resolved[0].release()
  await tick()
  assert.deepEqual(order, ['app-a', 'app-b'])
  resolved[1].release()
  await tick()
  assert.deepEqual(order, ['app-a', 'app-b', 'app-a'])
  resolved[2].release()
})

test('priority: a listed app jumps ahead of everyone else', async () => {
  const admission = build({ cloneCap: 1, priorityApps: ['vip'] })
  const running = await admission.acquire(meta('app-a'))
  const order: string[] = []
  const resolved: Grant[] = []
  const enq = (app: string): void => {
    admission
      .acquire(meta(app))
      .then((g) => {
        order.push(app)
        resolved.push(g)
      })
      .catch(() => {})
  }
  enq('app-a')
  enq('app-b')
  await tick()
  enq('vip') // arrives LAST but is on the priority list
  await tick()

  // The panel serving order (snapshot) already puts the priority app first.
  const snap = admission.snapshot()
  assert.deepEqual(snap.priorityApps, ['vip'])
  assert.equal(snap.classes.find((c) => c.name === 'clone')?.waiting[0]?.keyName, 'vip')

  running.release()
  await tick()
  assert.equal(order[0], 'vip') // served first despite arriving last
  resolved.forEach((g) => g.release())
})

test('backstop does not count our own upid-less grants as out-of-band', async () => {
  // A clone task the cluster lists while our grant has not attached its UPID yet.
  const tasks = [{ upid: 'UPID:n1:a:a:a:qmclone:200:root@pam:', type: 'qmclone' }]
  const upstream = { api: () => Promise.resolve(tasks) } as unknown as Upstream
  const admission = new Admission(upstream, {
    caps: { clone: 2, delete: 1, suspend: 1 },
    maxQueue: 2,
    maxHoldMs: 200,
    taskPollMs: 1_000_000,
    taskTimeoutMs: 1_000_000,
    priorityApps: [],
  })
  // Grant a clone but do NOT attach a UPID: the in-flight grant->attachTask window.
  const g = await admission.acquire(meta())
  await pollOutOfBand(admission)
  const clone = admission.snapshot().classes.find((c) => c.name === 'clone')
  // Our own in-flight grant is discounted, so nothing counts as out-of-band.
  assert.equal(clone?.outOfBand, 0)
  assert.equal(clone?.effectiveCap, 2)
  g.release()
})

test('stream guard ignores consoles on reserved vmids', async () => {
  // Two consoles on n1: one on a reserved infra vmid, one on an app vmid.
  const tasks = [
    { upid: 'UPID:n1:4:4:4:vncproxy:150:root@pam:', type: 'vncproxy', node: 'n1', id: '150' },
    {
      upid: 'UPID:n1:5:5:5:vncproxy:1100100:svc@pve:',
      type: 'vncproxy',
      node: 'n1',
      id: '1100100',
    },
  ]
  const upstream = { api: () => Promise.resolve(tasks) } as unknown as Upstream
  const admission = new Admission(upstream, {
    caps: { clone: 2, delete: 1, suspend: 1, power: 64 },
    maxQueue: 8,
    maxHoldMs: 200,
    taskPollMs: 1_000_000,
    taskTimeoutMs: 1_000_000,
    priorityApps: [],
    streamProtect: true,
    streamPacingMs: 0,
    reservedRanges: [[100, 199]],
  })
  await pollOutOfBand(admission)
  // Only the app console counts: the reserved one is operator work.
  assert.deepEqual(admission.snapshot().consoles, [{ node: 'n1', count: 1 }])

  // Drop the app console. The reserved one alone leaves the guard off, so
  // cap 2 admits two clones concurrently on the "watched" node.
  tasks.splice(1, 1)
  await pollOutOfBand(admission)
  assert.deepEqual(admission.snapshot().consoles, [])
  const a = await admission.acquire(meta())
  const b = await admission.acquire(meta('app-b'))
  assert.equal(admission.snapshot().classes.find((c) => c.name === 'clone')?.running.length, 2)
  a.release()
  b.release()
})
