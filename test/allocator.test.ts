import assert from 'node:assert/strict'
import { test } from 'node:test'
import { IdAllocator, VlanAllocator } from '../src/dataplane/allocator.js'
import { setNetTag } from '../src/dataplane/linkedclone.js'
import type { VlanLeaseStore } from '../src/dataplane/leases.js'
import type { ClusterSnapshot, ClusterVm } from '../src/upstream/cluster.js'

function fakeCluster(vmids: number[]): ClusterSnapshot {
  const vms = vmids.map(
    (vmid) =>
      ({
        vmid,
        node: 'n1',
        name: '',
        status: 'stopped',
        type: 'qemu',
        template: false,
      }) as ClusterVm,
  )
  return { vms: async () => vms } as unknown as ClusterSnapshot
}

function fakeLeases(active: number[]): VlanLeaseStore {
  return { activeVlans: () => new Set(active) } as unknown as VlanLeaseStore
}

test('IdAllocator picks the lowest free id and reserves it', async () => {
  const ids = new IdAllocator(fakeCluster([1100001, 1100100]))
  const a = await ids.allocate([[1100000, 1100999]])
  assert.equal(a, 1100000)
  // The next allocation must skip the just-reserved id even before the cluster
  // reflects the new VM.
  const b = await ids.allocate([[1100000, 1100999]])
  assert.equal(b, 1100002)
})

test('IdAllocator releases a reservation for reuse', async () => {
  const ids = new IdAllocator(fakeCluster([1100001]))
  const a = await ids.allocate([[1100000, 1100999]])
  assert.equal(a, 1100000)
  ids.release(1100000)
  const b = await ids.allocate([[1100000, 1100999]])
  assert.equal(b, 1100000)
})

test('IdAllocator returns null when the ranges are exhausted', async () => {
  const ids = new IdAllocator(fakeCluster([1100000, 1100001]))
  assert.equal(await ids.allocate([[1100000, 1100001]]), null)
})

test('VlanAllocator picks the lowest free tag and honors leases', () => {
  const vlans = new VlanAllocator(fakeLeases([1000]))
  assert.equal(vlans.allocate([1000, 1099]), 1001) // 1000 is leased
  assert.equal(vlans.allocate([1000, 1099]), 1002) // 1001 now reserved
  assert.equal(vlans.isFree(1000, [1000, 1099]), false)
  assert.equal(vlans.isFree(1050, [1000, 1099]), true)
  assert.equal(vlans.isFree(5000, [1000, 1099]), false) // out of range
})

test('setNetTag replaces or appends the vlan tag', () => {
  assert.equal(
    setNetTag('virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=1', 500),
    'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=500',
  )
  assert.equal(setNetTag('virtio=AA:BB,bridge=vmbr0', 500), 'virtio=AA:BB,bridge=vmbr0,tag=500')
})
