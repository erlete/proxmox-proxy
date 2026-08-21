import assert from 'node:assert/strict'
import { test } from 'node:test'
import { hashPassword, verifyPassword } from '../src/password.js'
import { signSession, verifySession } from '../src/session.js'

test('session roundtrip', () => {
  const token = signSession({ u: 'admin', exp: Date.now() + 60_000 }, 'secret')
  const payload = verifySession(token, 'secret')
  assert.equal(payload?.u, 'admin')
})

test('tampered or foreign sessions are rejected', () => {
  const token = signSession({ u: 'admin', exp: Date.now() + 60_000 }, 'secret')
  assert.equal(verifySession(token, 'other-secret'), null)
  assert.equal(verifySession(`x${token}`, 'secret'), null)
  assert.equal(verifySession('garbage', 'secret'), null)
})

test('expired sessions are rejected', () => {
  const token = signSession({ u: 'admin', exp: Date.now() - 1 }, 'secret')
  assert.equal(verifySession(token, 'secret'), null)
})

test('password hashing roundtrip', () => {
  const hash = hashPassword('hunter22')
  assert.ok(hash.startsWith('scrypt:'))
  assert.ok(verifyPassword('hunter22', hash))
  assert.ok(!verifyPassword('hunter23', hash))
  assert.ok(!verifyPassword('hunter22', 'garbage'))
})
