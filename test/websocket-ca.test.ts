import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { sanitizeCaBundle, websocketCaFrom } from '../src/upstream/websocket-ca.js'

// A throwaway CA and a leaf it signed (`nodo.test`), generated for these tests.
const fixtures = join(import.meta.dirname, 'fixtures')
const bundle = readFileSync(join(fixtures, 'upstream-ca-bundle.pem'), 'utf8')
const ca = readFileSync(join(fixtures, 'upstream-ca.pem'), 'utf8')

test('only the CA certificates of a bundle go out', () => {
  // The bundle holds the leaf first and the CA second: the leaf must not leak.
  assert.equal(sanitizeCaBundle(bundle), ca.trim() + '\n')
})

test('anything that is not a certificate is dropped', () => {
  const noisy = `-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n${ca}`
  assert.equal(sanitizeCaBundle(noisy), ca.trim() + '\n')
  assert.equal(
    sanitizeCaBundle('-----BEGIN CERTIFICATE-----\ngarbage\n-----END CERTIFICATE-----'),
    null,
  )
})

test('a file without any CA certificate gives nothing to vouch for', () => {
  const leafOnly = bundle.slice(0, bundle.indexOf(ca.trim()))
  assert.equal(sanitizeCaBundle(leafOnly), null)
})

test('without a CA file there is no websocket CA', () => {
  assert.equal(websocketCaFrom(null), null)
  assert.equal(websocketCaFrom(join(fixtures, 'upstream-ca-bundle.pem')), ca.trim() + '\n')
})
