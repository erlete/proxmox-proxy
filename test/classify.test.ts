import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authorize, classify, vmidFromUpid } from '../src/admission/classify.js'

test('classifies heavy operations', () => {
  assert.equal(classify('POST', '/api2/json/nodes/n1/qemu/1100100/clone').opClass, 'clone')
  assert.equal(classify('DELETE', '/api2/json/nodes/n1/qemu/1100100').opClass, 'delete')
  assert.equal(classify('POST', '/api2/json/nodes/n1/qemu/1100100/status/suspend').opClass, 'suspend')
  assert.equal(classify('POST', '/api2/extjs/nodes/n1/qemu/1100100/clone').opClass, 'clone')
})

test('pass operations carry no class', () => {
  assert.equal(classify('POST', '/api2/json/nodes/n1/qemu/1100100/status/start').opClass, null)
  assert.equal(classify('GET', '/api2/json/nodes/n1/qemu/1100100/status/current').opClass, null)
  assert.equal(classify('POST', '/api2/json/nodes/n1/qemu/1100100/vncproxy').opClass, null)
  assert.equal(classify('GET', '/api2/json/version').opClass, null)
})

test('extracts the vmid from the path', () => {
  assert.equal(classify('GET', '/api2/json/nodes/n1/qemu/1100123/status/current').pathVmid, 1100123)
  assert.equal(classify('GET', '/api2/json/nodes/n1/lxc/200/status/current').pathVmid, 200)
  assert.equal(classify('GET', '/api2/json/cluster/resources').pathVmid, null)
})

test('blocks identity endpoints', () => {
  assert.ok(classify('GET', '/api2/json/access/users').blocked)
  assert.ok(classify('POST', '/api2/json/access/ticket').blocked)
})

test('recovers the vmid from a task upid', () => {
  const upid = 'UPID:n1:0001A2B3:0004C5D6:65AC0FFE:qmclone:1100100:root@pam:'
  assert.equal(vmidFromUpid(upid), 1100100)
  assert.equal(vmidFromUpid('not-a-upid'), null)
  const cls = classify('GET', `/api2/json/nodes/n1/tasks/${encodeURIComponent(upid)}/status`)
  assert.equal(cls.upidVmid, 1100100)
})

test('authorize enforces the v0 policy', () => {
  const inRange = (vmid: number): boolean => vmid >= 1100100 && vmid <= 1100999

  // reads pass, scoped reads outside the range are denied
  assert.equal(authorize('GET', classify('GET', '/api2/json/version'), inRange), null)
  assert.equal(authorize('GET', classify('GET', '/api2/json/nodes/n1/qemu/1100100/status/current'), inRange), null)
  assert.ok(authorize('GET', classify('GET', '/api2/json/nodes/n1/qemu/999/status/current'), inRange))

  // writes need an in-range vmid in the path
  assert.equal(authorize('POST', classify('POST', '/api2/json/nodes/n1/qemu/1100100/status/start'), inRange), null)
  assert.ok(authorize('POST', classify('POST', '/api2/json/nodes/n1/qemu/999/status/start'), inRange))
  assert.ok(authorize('POST', classify('POST', '/api2/json/nodes/n1/qemu'), inRange))
  assert.ok(authorize('POST', classify('POST', '/api2/json/access/ticket'), inRange))
})
