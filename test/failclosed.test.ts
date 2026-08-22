import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import type { Admission } from '../src/admission/queue.js'
import { loadConfig } from '../src/config.js'
import { createDataPlaneHandler } from '../src/dataplane/server.js'
import { openDb } from '../src/db.js'
import { KeyStore } from '../src/keys/store.js'
import { OpsLog } from '../src/ops.js'
import { SettingsStore } from '../src/settings.js'
import { ConsoleBroker } from '../src/upstream/console.js'
import type { Upstream } from '../src/upstream/client.js'
import type { HealthMonitor } from '../src/upstream/health.js'

/**
 * Fail-closed contract: a contended op (clone/delete/suspend) must NEVER reach
 * the cluster when admission cannot vouch for it. Two ways admission can fail
 * to vouch:
 *   1. the admission machinery itself throws internally, and
 *   2. this proxy has lost the cluster singleton lock (it is no longer the
 *      admission authority).
 * In both cases the proxy answers 503 and the upstream is never touched.
 */

interface Harness {
  server: Server
  url: string
  token: string
  ops: OpsLog
  rawCalled: () => boolean
  close: () => Promise<void>
}

function buildPlane(opts: {
  singletonHeld: boolean
  admission: Pick<Admission, 'acquire'>
}): Harness {
  const db = openDb(':memory:')
  const config = loadConfig({
    PROXMOX_UPSTREAM_URL: 'http://127.0.0.1:1',
    PROXMOX_SERVICE_TOKEN: 'svc@pve!proxy=11111111-1111-1111-1111-111111111111',
    ADMIN_PASSWORD: 'x',
    SESSION_SECRET: 'x',
    DATA_DIR: ':memory:',
    SINGLETON_DISABLED: 'true',
  })
  const keys = new KeyStore(db, config.keysTokenUser)
  const token = keys.create('app-a', [[1100000, 1100999]], 'failclosed')
  const settings = new SettingsStore(db)
  const ops = new OpsLog(db, () => 20_000)

  let rawCalled = false
  const upstream = {
    // The whole point: this must never be invoked on a fail-closed path.
    raw: () => {
      rawCalled = true
      return Promise.reject(new Error('upstream must not be called on a fail-closed path'))
    },
  } as unknown as Upstream

  const health = {
    state: { ok: true, version: '8.4.1', checkedAt: Date.now(), error: null },
  } as HealthMonitor

  const server = createServer(
    createDataPlaneHandler({
      config,
      keys,
      settings,
      upstream,
      admission: opts.admission as Admission,
      health,
      console: new ConsoleBroker(upstream, null),
      singletonHeld: () => opts.singletonHeld,
      ops,
    }),
  )

  return {
    server,
    url: '',
    token,
    ops,
    rawCalled: () => rawCalled,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}

async function listen(h: Harness): Promise<Harness> {
  await new Promise<void>((r) => h.server.listen(0, '127.0.0.1', r))
  h.url = `http://127.0.0.1:${(h.server.address() as AddressInfo).port}`
  return h
}

function clone(h: Harness): Promise<Response> {
  return fetch(`${h.url}/api2/json/nodes/n1/qemu/1100050/clone`, {
    method: 'POST',
    headers: { authorization: h.token, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'newid=1100100',
  })
}

test('internal admission failure fails closed (503, upstream untouched)', async () => {
  const h = await listen(
    buildPlane({
      singletonHeld: true,
      admission: { acquire: () => Promise.reject(new Error('boom: internal admission bug')) },
    }),
  )
  try {
    const res = await clone(h)
    assert.equal(res.status, 503)
    assert.equal(res.headers.get('retry-after'), '5')
    assert.equal(h.rawCalled(), false, 'the operation must not reach the cluster')
    const note = h.ops.list({ limit: 5 }).find((r) => r.opClass === 'clone')?.note
    assert.equal(note, 'admission-error')
  } finally {
    await h.close()
  }
})

test('losing the cluster lock fails closed for contended ops', async () => {
  const h = await listen(
    buildPlane({
      singletonHeld: false,
      // acquire must not even be reached: prove it by throwing if it is.
      admission: {
        acquire: () => {
          throw new Error('acquire must not run once the lock is lost')
        },
      },
    }),
  )
  try {
    const res = await clone(h)
    assert.equal(res.status, 503)
    assert.equal(res.headers.get('retry-after'), '10')
    assert.equal(h.rawCalled(), false, 'a non-authority proxy must not forward contended ops')
    const note = h.ops.list({ limit: 5 }).find((r) => r.opClass === 'clone')?.note
    assert.equal(note, 'not-authority')
  } finally {
    await h.close()
  }
})
