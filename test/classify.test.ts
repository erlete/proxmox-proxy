import assert from 'node:assert/strict'
import { test } from 'node:test'
import { authorize, classify, vmidFromUpid } from '../src/admission/classify.js'

test('classifies heavy operations', () => {
  assert.equal(classify('POST', '/api2/json/nodes/n1/qemu/1100100/clone').opClass, 'clone')
  assert.equal(classify('DELETE', '/api2/json/nodes/n1/qemu/1100100').opClass, 'delete')
  assert.equal(
    classify('POST', '/api2/json/nodes/n1/qemu/1100100/status/suspend').opClass,
    'suspend',
  )
  assert.equal(classify('POST', '/api2/extjs/nodes/n1/qemu/1100100/clone').opClass, 'clone')
})

test('qemu and lxc share heavy classification and body targets', () => {
  const lxcClone = classify('POST', '/api2/json/nodes/n1/lxc/200/clone')
  assert.equal(lxcClone.opClass, 'clone')
  assert.equal(lxcClone.bodyTarget, 'newid')
  assert.equal(classify('POST', '/api2/json/nodes/n1/qemu/100/clone').bodyTarget, 'newid')
  assert.equal(classify('DELETE', '/api2/json/nodes/n1/lxc/200').opClass, 'delete')
  assert.equal(classify('POST', '/api2/json/nodes/n1/lxc/200/status/suspend').opClass, 'suspend')

  const move = classify('POST', '/api2/json/nodes/n1/qemu/100/move_disk')
  assert.equal(move.opClass, null)
  assert.equal(move.bodyTarget, 'target-vmid')
  assert.equal(
    classify('POST', '/api2/json/nodes/n1/lxc/200/move_volume').bodyTarget,
    'target-vmid',
  )
})

test('classifies cluster-wide list reads for opacity filtering', () => {
  assert.equal(classify('GET', '/api2/json/cluster/resources').listScope, 'resources')
  assert.equal(classify('GET', '/api2/json/nodes/n1/qemu').listScope, 'guests')
  assert.equal(classify('GET', '/api2/json/nodes/n1/lxc').listScope, 'guests')
  assert.equal(classify('GET', '/api2/json/nodes/n1/tasks').listScope, 'tasks')
  // A specific guest or task is not a list.
  assert.equal(classify('GET', '/api2/json/nodes/n1/qemu/1100100/status/current').listScope, null)
  assert.equal(classify('GET', '/api2/json/version').listScope, null)
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
  assert.equal(
    authorize('GET', classify('GET', '/api2/json/nodes/n1/qemu/1100100/status/current'), inRange),
    null,
  )
  assert.ok(
    authorize('GET', classify('GET', '/api2/json/nodes/n1/qemu/999/status/current'), inRange),
  )

  // writes need an in-range vmid in the path
  assert.equal(
    authorize('POST', classify('POST', '/api2/json/nodes/n1/qemu/1100100/status/start'), inRange),
    null,
  )
  assert.ok(
    authorize('POST', classify('POST', '/api2/json/nodes/n1/qemu/999/status/start'), inRange),
  )
  assert.ok(authorize('POST', classify('POST', '/api2/json/nodes/n1/qemu'), inRange))
  assert.ok(authorize('POST', classify('POST', '/api2/json/access/ticket'), inRange))
})
