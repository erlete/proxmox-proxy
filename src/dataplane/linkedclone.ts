import type { Admission, Grant } from '../admission/queue.js'
import { vmidAllowed, type ApiKeyRecord } from '../keys/store.js'
import { log } from '../log.js'
import type { SettingsStore } from '../settings.js'
import type { ClusterSnapshot } from '../upstream/cluster.js'
import { UpstreamError, type Upstream } from '../upstream/client.js'
import { IdAllocator, VlanAllocator } from './allocator.js'
import { VlanLeaseStore } from './leases.js'

const MAX_GROUP = 16

export class LinkedCloneError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'LinkedCloneError'
  }
}

export interface LinkedCloneRequest {
  node: string
  clones: Array<{ template: number; name?: string; full?: boolean }>
  /** Optional explicit tag; must be inside the range and free. Omit to auto-pick. */
  vlan?: number
}

export interface LinkedCloneResult {
  vlan: number
  clones: Array<{ template: number; vmid: number; upid: string }>
}

interface TaskStatus {
  status: string
  exitstatus?: string
}

/** Replace (or append) the 802.1q `tag=` field of a Proxmox net string. */
export function setNetTag(net: string, vlan: number): string {
  const parts = net.split(',').filter((p) => p.length > 0)
  let found = false
  const out = parts.map((p) => {
    if (p.startsWith('tag=')) {
      found = true
      return `tag=${vlan}`
    }
    return p
  })
  if (!found) out.push(`tag=${vlan}`)
  return out.join(',')
}

export interface LinkedCloneDeps {
  upstream: Upstream
  admission: Admission
  cluster: ClusterSnapshot
  leases: VlanLeaseStore
  ids: IdAllocator
  vlans: VlanAllocator
  settings: SettingsStore
}

/**
 * Clones a group of templates as one isolated pod: every member is a linked
 * clone (full=0 by default), all share one freshly leased VLAN tag, and the
 * proxy returns them already configured. The whole group is atomic: any failure
 * rolls back the VMs already created and frees the VLAN.
 *
 * Newid selection and VLAN selection both live here (the proxy owns them), so
 * the app supplies only the templates and gets back the created VMIDs and tag.
 */
export class LinkedCloneService {
  constructor(private deps: LinkedCloneDeps) {}

  private async waitTask(node: string, upid: string, signal: AbortSignal): Promise<void> {
    const { settings, upstream } = this.deps
    const pollMs = settings.all.taskPollMs
    const timeoutMs = settings.all.taskTimeoutMs
    const started = Date.now()
    for (;;) {
      if (signal.aborted) throw new LinkedCloneError('client disconnected', 499)
      const status = await upstream.api<TaskStatus>(
        'GET',
        `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`,
      )
      if (status.status === 'stopped') {
        if (status.exitstatus && status.exitstatus !== 'OK') {
          throw new LinkedCloneError(`clone task failed: ${status.exitstatus}`, 502)
        }
        return
      }
      if (Date.now() - started > timeoutMs) {
        throw new LinkedCloneError('clone task exceeded the safety timeout', 504)
      }
      await new Promise((r) => setTimeout(r, pollMs))
    }
  }

  private async retagNet0(node: string, vmid: number, vlan: number): Promise<void> {
    const { upstream } = this.deps
    const config = await upstream.api<{ net0?: string }>(
      'GET',
      `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/config`,
    )
    if (!config.net0) {
      throw new LinkedCloneError(`clone ${vmid} has no net0 to place on the pod VLAN`, 502)
    }
    await upstream.api('PUT', `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/config`, {
      net0: setNetTag(config.net0, vlan),
    })
  }

  /** Best-effort bounded wait for a task to stop, so a locked VM can be deleted
   * during rollback. Never throws; caps the wait so rollback cannot hang. */
  private async waitTaskQuiet(node: string, upid: string): Promise<void> {
    const { settings, upstream } = this.deps
    const pollMs = settings.all.taskPollMs
    const deadline = Date.now() + Math.min(settings.all.taskTimeoutMs, 120_000)
    try {
      for (;;) {
        const status = await upstream.api<TaskStatus>(
          'GET',
          `/nodes/${encodeURIComponent(node)}/tasks/${encodeURIComponent(upid)}/status`,
        )
        if (status.status === 'stopped' || Date.now() > deadline) return
        await new Promise((r) => setTimeout(r, pollMs))
      }
    } catch {
      // best-effort: a failed poll just means we delete without waiting
    }
  }

  private async destroyQuietly(node: string, vmid: number): Promise<void> {
    try {
      await this.deps.upstream.api('DELETE', `/nodes/${encodeURIComponent(node)}/qemu/${vmid}`)
    } catch (err) {
      log.warn('linked-clone rollback delete failed', { vmid, error: String(err) })
    }
  }

  async run(
    key: ApiKeyRecord,
    req: LinkedCloneRequest,
    signal: AbortSignal,
  ): Promise<LinkedCloneResult> {
    const { admission, cluster, ids, vlans, leases, settings } = this.deps
    const range = settings.all.linkedVlanRange
    if (!range) {
      throw new LinkedCloneError('linked cloning is not configured (no linked VLAN range)', 501)
    }
    if (!/^[A-Za-z0-9._-]{1,63}$/.test(req.node)) {
      throw new LinkedCloneError('invalid node', 400)
    }
    if (!Array.isArray(req.clones) || req.clones.length === 0) {
      throw new LinkedCloneError('at least one template is required', 400)
    }
    if (req.clones.length > MAX_GROUP) {
      throw new LinkedCloneError(`a group may not exceed ${MAX_GROUP} clones`, 400)
    }

    const snapshot = await cluster.vms()
    const byId = new Map(snapshot.map((vm) => [vm.vmid, vm]))
    for (const c of req.clones) {
      if (!Number.isInteger(c.template) || c.template <= 0) {
        throw new LinkedCloneError('invalid template vmid', 400)
      }
      if (!vmidAllowed(key.vmidRanges, c.template)) {
        throw new LinkedCloneError(`template ${c.template} is outside the ranges of this key`, 403)
      }
      const vm = byId.get(c.template)
      if (!vm) throw new LinkedCloneError(`template ${c.template} does not exist`, 404)
      if (!vm.template) throw new LinkedCloneError(`vmid ${c.template} is not a template`, 400)
    }

    // Choose the pod VLAN: honor an explicit in-range free tag, else auto-pick.
    let vlan: number
    if (req.vlan !== undefined) {
      if (!vlans.isFree(req.vlan, range)) {
        throw new LinkedCloneError(`vlan ${req.vlan} is not free or outside the range`, 409)
      }
      vlan = req.vlan
      vlans.reserve(vlan)
    } else {
      const picked = vlans.allocate(range)
      if (picked === null) throw new LinkedCloneError('no free VLAN in the linked range', 503)
      vlan = picked
    }

    const created: Array<{ template: number; vmid: number; upid: string }> = []
    const grants: Grant[] = []
    // A newid reserved for a clone that failed before it was recorded in
    // `created` (admission or the clone POST threw): its POST may still have
    // taken effect on the cluster, so rollback tries to destroy it too.
    let pendingNewid: number | null = null
    const rollback = async (): Promise<void> => {
      for (const g of grants) g.release('linked-clone-rollback')
      const toDestroy = created.map((c) => ({ vmid: c.vmid, upid: c.upid as string | null }))
      if (pendingNewid != null) toDestroy.push({ vmid: pendingNewid, upid: null })
      for (const { vmid, upid } of toDestroy) {
        ids.release(vmid)
        // A clone task still running holds a lock that would reject the delete,
        // so wait for it to settle first (bounded, best-effort).
        if (upid) await this.waitTaskQuiet(req.node, upid)
        await this.destroyQuietly(req.node, vmid)
      }
      vlans.release(vlan)
    }

    try {
      for (const c of req.clones) {
        if (signal.aborted) throw new LinkedCloneError('client disconnected', 499)
        const newid = await ids.allocate(key.vmidRanges)
        if (newid === null) throw new LinkedCloneError('the key ranges are exhausted', 507)
        pendingNewid = newid

        const grant = await admission.acquire(
          { opClass: 'clone', keyName: key.name, vmid: newid, node: req.node },
          signal,
        )
        grants.push(grant)

        const body: Record<string, string | number> = { newid, full: c.full ? 1 : 0 }
        if (c.name) body.name = c.name
        const upid = await this.deps.upstream.api<string>(
          'POST',
          `/nodes/${encodeURIComponent(req.node)}/qemu/${c.template}/clone`,
          body,
        )
        created.push({ template: c.template, vmid: newid, upid })
        pendingNewid = null

        await this.waitTask(req.node, upid, signal)
        await this.retagNet0(req.node, newid, vlan)
        grant.release('linked-clone')
      }
    } catch (err) {
      await rollback()
      cluster.invalidate()
      if (err instanceof LinkedCloneError) throw err
      // Do not leak upstream/internal detail to the app; log it, return generic.
      log.warn('linked clone failed against the cluster', { key: key.name, error: String(err) })
      const status = err instanceof UpstreamError ? err.statusCode : 502
      throw new LinkedCloneError('linked clone failed against the cluster', status)
    }

    leases.create({
      vlan,
      vmids: created.map((c) => c.vmid),
      keyName: key.name,
      node: req.node,
      createdAt: Date.now(),
    })
    vlans.release(vlan) // now covered by the persisted lease
    cluster.invalidate() // the new VMs must show up immediately in the inventory
    log.info('linked-clone group provisioned', {
      key: key.name,
      vlan,
      vmids: created.map((c) => c.vmid),
    })
    return { vlan, clones: created }
  }
}

export interface VlanReaperOpts {
  intervalMs?: number
  /** A lease younger than this is never reaped (covers the /cluster/resources
   * propagation lag for a freshly created pod). */
  graceMs?: number
  /** Consecutive ticks a lease's VMs must be absent before it is reaped, so one
   * transient snapshot cannot free a live pod's VLAN. */
  requiredMisses?: number
}

/**
 * Reaper: frees a VLAN lease once its pod is gone, so a torn-down pod releases
 * its tag with no explicit call from the app. It is deliberately conservative,
 * because wrongly freeing a live pod's tag would let two tenants share a VLAN
 * (an isolation breach), whereas a delayed free is merely a bounded leak:
 *   - never reaps on an empty snapshot (quorum loss / restart look like "all
 *     VMs gone" but are transient);
 *   - never reaps a lease younger than `graceMs` (propagation lag);
 *   - reaps only after `requiredMisses` consecutive ticks with the pod absent.
 * Returns a stop function.
 */
export function startVlanReaper(
  cluster: ClusterSnapshot,
  leases: VlanLeaseStore,
  opts: VlanReaperOpts = {},
): () => void {
  const intervalMs = opts.intervalMs ?? 60_000
  const graceMs = opts.graceMs ?? 15 * 60_000
  const requiredMisses = opts.requiredMisses ?? 2
  const misses = new Map<number, number>() // vlan -> consecutive absent ticks
  let stopped = false

  const tick = async (): Promise<void> => {
    if (stopped) return
    let vms
    try {
      vms = await cluster.vms()
    } catch (err) {
      log.warn('vlan lease reaper tick failed', { error: String(err) })
      return
    }
    // A shutdown may have landed while we awaited: do not touch the DB now.
    if (stopped) return
    // An empty VM list is almost always transient (quorum loss, restart), not
    // "everything was deleted": never reap on it.
    if (vms.length === 0) return
    const alive = new Set(vms.map((vm) => vm.vmid))
    const now = Date.now()
    for (const lease of leases.list()) {
      if (lease.vmids.some((vmid) => alive.has(vmid))) {
        misses.delete(lease.vlan)
        continue
      }
      if (now - lease.createdAt < graceMs) continue // too young to trust as gone
      const streak = (misses.get(lease.vlan) ?? 0) + 1
      if (streak >= requiredMisses) {
        leases.remove(lease.vlan)
        misses.delete(lease.vlan)
        log.info('vlan lease reaped', { vlan: lease.vlan, key: lease.keyName })
      } else {
        misses.set(lease.vlan, streak)
      }
    }
  }

  const timer = setInterval(() => void tick(), intervalMs)
  timer.unref()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
