import type { Upstream } from './client.js'

export interface ClusterVm {
  vmid: number
  node: string
  name: string
  status: string
  type: string
  /** A template has no power state and can only be cloned from, never managed. */
  template: boolean
}

interface RawClusterVm {
  vmid: number
  node: string
  name?: string
  status?: string
  type?: string
  template?: number
}

/**
 * Short-lived cache of the cluster's VM list. Shared by the admin inventory,
 * the data-plane id allocator, the template guard and the VLAN lease reaper, so
 * they all agree on what exists without each hammering `/cluster/resources`.
 */
export class ClusterSnapshot {
  private cache: { at: number; vms: ClusterVm[] } | null = null
  private inflight: Promise<ClusterVm[]> | null = null

  constructor(
    private upstream: Upstream,
    private ttlMs = 5_000,
  ) {}

  async vms(force = false): Promise<ClusterVm[]> {
    if (!force && this.cache && Date.now() - this.cache.at < this.ttlMs) return this.cache.vms
    // Single-flight: concurrent callers after an invalidate share one fetch
    // instead of each hitting /cluster/resources.
    if (this.inflight) return this.inflight
    this.inflight = this.fetch().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async fetch(): Promise<ClusterVm[]> {
    const rows = await this.upstream.api<RawClusterVm[]>('GET', '/cluster/resources?type=vm')
    const vms: ClusterVm[] = rows.map((r) => ({
      vmid: r.vmid,
      node: r.node,
      name: r.name ?? '',
      status: r.status ?? 'unknown',
      type: r.type ?? 'qemu',
      template: r.template === 1,
    }))
    this.cache = { at: Date.now(), vms }
    return vms
  }

  async byVmid(vmid: number, force = false): Promise<ClusterVm | undefined> {
    return (await this.vms(force)).find((vm) => vm.vmid === vmid)
  }

  invalidate(): void {
    this.cache = null
  }
}
