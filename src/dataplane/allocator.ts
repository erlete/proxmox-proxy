import type { VmidRange } from '../keys/store.js'
import type { ClusterSnapshot } from '../upstream/cluster.js'
import type { VlanLeaseStore } from './leases.js'

/**
 * In-flight reservation set with per-entry expiry. A reserved value is treated
 * as taken until the underlying cluster state catches up (the clone becomes
 * visible, the lease is written) or the hold expires, so two concurrent
 * requests never pick the same value.
 */
class Reservations {
  private held = new Map<number, number>()

  constructor(private holdMs: number) {}

  private sweep(): void {
    const now = Date.now()
    for (const [value, exp] of this.held) if (exp <= now) this.held.delete(value)
  }

  has(value: number): boolean {
    const exp = this.held.get(value)
    if (exp === undefined) return false
    if (exp <= Date.now()) {
      this.held.delete(value)
      return false
    }
    return true
  }

  reserve(value: number): void {
    this.held.set(value, Date.now() + this.holdMs)
  }

  release(value: number): void {
    this.held.delete(value)
  }

  all(): number[] {
    this.sweep()
    return [...this.held.keys()]
  }
}

/**
 * Assigns the lowest free VMID inside a key's ranges. "Free" excludes every VM
 * the cluster already has (templates included) and any id reserved in flight,
 * so the proxy can own id selection with no help from the app.
 */
export class IdAllocator {
  private reservations: Reservations

  constructor(
    private cluster: ClusterSnapshot,
    holdMs = 120_000,
  ) {
    this.reservations = new Reservations(holdMs)
  }

  async allocate(ranges: VmidRange[]): Promise<number | null> {
    const vms = await this.cluster.vms()
    const used = new Set<number>()
    for (const vm of vms) used.add(vm.vmid)
    for (const value of this.reservations.all()) used.add(value)
    for (const [min, max] of ranges) {
      for (let id = min; id <= max; id++) {
        if (!used.has(id)) {
          this.reservations.reserve(id)
          return id
        }
      }
    }
    return null
  }

  release(vmid: number): void {
    this.reservations.release(vmid)
  }
}

/**
 * Assigns a free VLAN tag from the configured linked-VLAN range. The lease
 * store is the occupied set (the range is dedicated to linked cloning), plus
 * in-flight reservations for groups mid-provision.
 */
export class VlanAllocator {
  private reservations = new Reservations(300_000)

  constructor(private leases: VlanLeaseStore) {}

  /** Lowest free tag in [start, end], or null if the range is exhausted. */
  allocate(range: [number, number]): number | null {
    const [start, end] = range
    const active = this.leases.activeVlans()
    for (let tag = start; tag <= end; tag++) {
      if (!active.has(tag) && !this.reservations.has(tag)) {
        this.reservations.reserve(tag)
        return tag
      }
    }
    return null
  }

  /** True when the tag is inside the range and not already taken. */
  isFree(tag: number, range: [number, number]): boolean {
    const [start, end] = range
    if (tag < start || tag > end) return false
    return !this.leases.activeVlans().has(tag) && !this.reservations.has(tag)
  }

  reserve(tag: number): void {
    this.reservations.reserve(tag)
  }

  release(tag: number): void {
    this.reservations.release(tag)
  }
}
