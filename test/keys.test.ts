import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openDb } from '../src/db.js'
import { KeyStore, validRanges, vmidAllowed } from '../src/keys/store.js'

const USER = 'svc-proxy@pve'

function parseSecret(token: string): { name: string; secret: string } {
  const m = /^PVEAPIToken=[^!]+!([^=]+)=(.+)$/.exec(token)
  assert.ok(m, `unexpected token format: ${token}`)
  return { name: m[1], secret: m[2] }
}

test('create, verify and scope', () => {
  const store = new KeyStore(openDb(':memory:'), USER)
  const token = store.create('app-a', [[1100100, 1100999]], 'first app')
  const { name, secret } = parseSecret(token)

  assert.equal(name, 'app-a')
  assert.ok(store.verify(USER, 'app-a', secret))
  assert.equal(store.verify(USER, 'app-a', 'wrong'), null)
  assert.equal(store.verify('other@pve', 'app-a', secret), null)
  assert.equal(store.verify(USER, 'missing', secret), null)

  const record = store.verify(USER, 'app-a', secret)
  assert.ok(record)
  assert.ok(vmidAllowed(record.vmidRanges, 1100500))
  assert.ok(!vmidAllowed(record.vmidRanges, 2200500))
})

test('rotation keeps the previous secret during the grace window', () => {
  const store = new KeyStore(openDb(':memory:'), USER)
  const first = parseSecret(store.create('app-b', [[100, 999]]))
  const second = parseSecret(store.rotate('app-b', 60_000))

  assert.ok(store.verify(USER, 'app-b', second.secret), 'new secret works')
  assert.ok(store.verify(USER, 'app-b', first.secret), 'old secret survives the grace window')

  const third = parseSecret(store.rotate('app-b', 0))
  assert.ok(store.verify(USER, 'app-b', third.secret))
  assert.equal(store.verify(USER, 'app-b', second.secret), null, 'no grace means instant cutoff')
})

test('revocation is permanent and the name stays reserved', () => {
  const store = new KeyStore(openDb(':memory:'), USER)
  const { secret } = parseSecret(store.create('app-c', [[100, 999]]))
  assert.ok(store.revoke('app-c'))
  assert.equal(store.verify(USER, 'app-c', secret), null)
  assert.throws(() => store.create('app-c', [[100, 999]]))
})

test('keys persist across store instances', () => {
  const db = openDb(':memory:')
  const { secret } = parseSecret(new KeyStore(db, USER).create('app-d', [[100, 999]]))
  const reloaded = new KeyStore(db, USER)
  assert.ok(reloaded.verify(USER, 'app-d', secret))
})

test('range validation', () => {
  assert.ok(validRanges([[100, 999]]))
  assert.ok(!validRanges([]))
  assert.ok(!validRanges([[999, 100]]))
  assert.ok(!validRanges([[1, 999]]))
  assert.ok(!validRanges('nope'))
})
