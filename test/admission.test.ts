import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  Admission,
  HoldTimeoutError,
  QueueFullError,
  type GrantMeta,
} from '../src/admission/queue.js'

const meta = (keyName = 'app-a'): GrantMeta => ({
  opClass: 'clone',
  keyName,
  vmid: 1100100,
  node: 'n1',
})

function build(
  overrides: Partial<{ cloneCap: number; maxQueue: number; maxHoldMs: number }> = {},
): Admission {
  return new Admission(null, {
    caps: { clone: overrides.cloneCap ?? 1, delete: 1, suspend: 1 },
    maxQueue: overrides.maxQueue ?? 2,
    maxHoldMs: overrides.maxHoldMs ?? 200,
    taskPollMs: 1_000_000,
    taskTimeoutMs: 1_000_000,
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
