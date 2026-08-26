import type { Admission, Grant } from '../admission/queue.js'
import { vmidAllowed, type ApiKeyRecord } from '../keys/store.js'
import { log } from '../log.js'
import type { SettingsStore } from '../settings.js'
import type { ClusterSnapshot } from '../upstream/cluster.js'
import { UpstreamError, type Upstream } from '../upstream/client.js'
import { IdAllocator, VlanAllocator } from './allocator.js'
import { VlanLeaseStore, type VlanLease } from './leases.js'

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

/** Power actions a whole group accepts in one call. `start` also resumes a
 * pod that was suspended to disk. */
export type GroupAction = 'start' | 'stop' | 'shutdown' | 'reset' | 'suspend'
export const GROUP_ACTIONS: readonly GroupAction[] = [
  'start',
  'stop',
  'shutdown',
  'reset',
  'suspend',
]

export interface GroupDestroyResult {
  vlan: number
  destroyed: number[]
}

export interface GroupPowerResult {
  vlan: number
  node: string
  action: GroupAction
  members: Array<{ vmid: number; ok: boolean; upid: string | null; error?: string }>
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

  /** Resolve a group by its VLAN and assert the key owns it. A group is the
   * unit of operation: it is addressed by the VLAN tag returned at creation. */
  private resolveGroup(key: ApiKeyRecord, vlan: number): VlanLease {
    const lease = this.deps.leases.get(vlan)
    if (!lease) throw new LinkedCloneError(`no group is leased on vlan ${vlan}`, 404)
    if (lease.keyName !== key.name) {
      throw new LinkedCloneError(`vlan ${vlan} belongs to another app`, 403)
    }
    for (const vmid of lease.vmids) {
      if (!vmidAllowed(key.vmidRanges, vmid)) {
        throw new LinkedCloneError(`group member ${vmid} is outside the ranges of this key`, 403)
      }
    }
    return lease
  }

  /**
   * Destroy every member of a group in one call and free its VLAN. Idempotent:
   * a member already gone is treated as done. The lease (and thus the VLAN) is
   * released only when the whole pod is confirmed gone; a partial failure keeps
   * it so a retry finishes the job.
   */
  async destroyGroup(
    key: ApiKeyRecord,
    vlan: number,
    signal: AbortSignal,
  ): Promise<GroupDestroyResult> {
    const { admission, cluster, ids, leases, upstream } = this.deps
    const lease = this.resolveGroup(key, vlan)
    // A FRESH snapshot (never the 5s cache) so a member cannot be mistaken for
    // gone from a stale read. An empty snapshot is a transient cluster fault
    // (quorum loss returns [] with a 200), NOT "everything was deleted": refuse
    // to act, because freeing this VLAN with members still alive would let it be
    // re-leased to another tenant (an isolation breach), the very thing the
    // lease exists to prevent.
    const snapshot = await cluster.vms(true)
    if (snapshot.length === 0) {
      throw new LinkedCloneError('cannot verify the cluster right now, retry shortly', 503)
    }
    const byId = new Map(snapshot.map((vm) => [vm.vmid, vm]))
    const node = encodeURIComponent(lease.node)
    const destroyed: number[] = []
    const failed: number[] = []
    for (const vmid of lease.vmids) {
      if (signal.aborted) throw new LinkedCloneError('client disconnected', 499)
      const vm = byId.get(vmid)
      if (!vm) {
        destroyed.push(vmid) // absent from a fresh, non-empty snapshot: gone
        ids.release(vmid)
        continue
      }
      if (vm.template) {
        // A template must never be destroyed. It cannot legitimately be a group
        // member; skip it (never delete a golden image) but do NOT let it block
        // freeing the VLAN, or the lease would leak forever.
        log.warn('group destroy skipped a template member', { vlan, vmid })
        continue
      }
      const grant = await admission.acquire(
        { opClass: 'delete', keyName: key.name, vmid, node: lease.node },
        signal,
      )
      try {
        // Destroy means we do not care about the running state: a running VM
        // cannot be deleted, so force-stop it first (idempotent, one pass).
        if (vm.status === 'running') {
          await this.waitTask(
            lease.node,
            await upstream.api<string>('POST', `/nodes/${node}/qemu/${vmid}/status/stop`),
            signal,
          )
        }
        const upid = await upstream.api<string>('DELETE', `/nodes/${node}/qemu/${vmid}`)
        await this.waitTask(lease.node, upid, signal)
        destroyed.push(vmid)
        ids.release(vmid)
      } catch (err) {
        if (err instanceof LinkedCloneError && err.status === 499) throw err
        log.warn('group destroy member failed', { vlan, vmid, error: String(err) })
        failed.push(vmid)
      } finally {
        grant.release('group-destroy')
      }
    }
    cluster.invalidate()
    if (failed.length > 0) {
      // Keep the lease so a retry can finish; the VLAN stays reserved.
      throw new LinkedCloneError(
        `group on vlan ${vlan}: ${failed.length} member(s) could not be destroyed`,
        502,
      )
    }
    leases.remove(vlan) // whole pod gone: free the VLAN
    log.info('group destroyed', { key: key.name, vlan, destroyed })
    return { vlan, destroyed }
  }

  /** Apply one power action to every member of a group in a single call. */
  async groupPower(
    key: ApiKeyRecord,
    vlan: number,
    action: GroupAction,
    signal: AbortSignal,
  ): Promise<GroupPowerResult> {
    const { cluster } = this.deps
    const lease = this.resolveGroup(key, vlan)
    const byId = new Map((await cluster.vms()).map((vm) => [vm.vmid, vm]))
    const members: GroupPowerResult['members'] = []
    for (const vmid of lease.vmids) {
      if (signal.aborted) throw new LinkedCloneError('client disconnected', 499)
      const vm = byId.get(vmid)
      if (!vm) {
        members.push({ vmid, ok: false, upid: null, error: 'not found' })
        continue
      }
      if (vm.template) {
        members.push({ vmid, ok: false, upid: null, error: 'template' })
        continue
      }
      try {
        const upid = await this.powerOne(key, lease.node, vmid, action, signal)
        members.push({ vmid, ok: true, upid })
      } catch (err) {
        if (err instanceof LinkedCloneError && err.status === 499) throw err
        const error = err instanceof LinkedCloneError ? err.message : 'operation failed'
        members.push({ vmid, ok: false, upid: null, error })
      }
    }
    cluster.invalidate()
    return { vlan, node: lease.node, action, members }
  }

  /** One member's power op, waiting for its task. Suspend contends for pool
   * I/O (its own class); the rest go through the power class, which is free
   * with no console open and serialized by the stream guard when one is. */
  private async powerOne(
    key: ApiKeyRecord,
    node: string,
    vmid: number,
    action: GroupAction,
    signal: AbortSignal,
  ): Promise<string> {
    const { admission, upstream } = this.deps
    const base = `/nodes/${encodeURIComponent(node)}/qemu/${vmid}/status`
    const opClass = action === 'suspend' ? 'suspend' : 'power'
    const grant = await admission.acquire({ opClass, keyName: key.name, vmid, node }, signal)
    try {
      const upid =
        action === 'suspend'
          ? await upstream.api<string>('POST', `${base}/suspend`, { todisk: 1 })
          : await upstream.api<string>('POST', `${base}/${action}`)
      await this.waitTask(node, upid, signal)
      return upid
    } finally {
      grant.release(`group-${action}`)
    }
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
