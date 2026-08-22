import type { OpClassName } from '../config.js'

export interface Classified {
  opClass: OpClassName | null
  node: string | null
  /** VMID present in the path itself (qemu/lxc segments). */
  pathVmid: number | null
  /** VMID recovered from a task UPID in the path, if any. */
  upidVmid: number | null
  /**
   * Body parameter naming a TARGET VMID this op creates or mutates (clone's
   * `newid`, move_disk/move_volume's `target-vmid`). The forwarder must read it
   * and enforce key scope (and, for a move, the template guard) on it: the path
   * VMID is only the source.
   */
  bodyTarget: 'newid' | 'target-vmid' | null
  /**
   * A cluster-wide LIST read whose response must be filtered to the key's own
   * VMIDs (opacity): the app must never see a VM outside its ranges.
   *  - 'resources': /cluster/resources (drop foreign guests, keep infra rows)
   *  - 'guests':    /nodes/{node}/{qemu,lxc} (drop foreign guests)
   *  - 'tasks':     /nodes/{node}/tasks (drop tasks for foreign VMIDs)
   *  - 'storage':   /nodes/{node}/storage/{s}/content (drop foreign volumes)
   */
  listScope: 'resources' | 'guests' | 'tasks' | 'storage' | null
  /** True when the path is a task status/log read (`/tasks/{upid}/...`). */
  isTaskPath: boolean
  /** Non-null = deny with this reason. */
  blocked: string | null
}

// qemu and lxc share the same pool cost, so both are gated / target-checked.
const CLONE_RE = /^\/api2\/(?:json|extjs)\/nodes\/([^/]+)\/(?:qemu|lxc)\/(\d+)\/clone\/?$/
const DELETE_RE = /^\/api2\/(?:json|extjs)\/nodes\/([^/]+)\/(?:qemu|lxc)\/(\d+)\/?$/
const SUSPEND_RE =
  /^\/api2\/(?:json|extjs)\/nodes\/([^/]+)\/(?:qemu|lxc)\/(\d+)\/status\/suspend\/?$/
// A disk/volume move can attach onto a DIFFERENT target VM named in the body.
const MOVE_RE =
  /^\/api2\/(?:json|extjs)\/nodes\/([^/]+)\/(?:qemu\/(\d+)\/move_disk|lxc\/(\d+)\/move_volume)\/?$/
const GENERIC_VMID_RE = /\/(?:qemu|lxc)\/(\d+)(?:\/|$)/
const NODE_RE = /^\/api2\/(?:json|extjs)\/nodes\/([^/]+)/
const ACCESS_RE = /^\/api2\/[^/]+\/access(?:\/|$)/
const TASK_RE = /^\/api2\/(?:json|extjs)\/nodes\/[^/]+\/tasks\/([^/]+)/
// Endpoints an app has no business using through the proxy and that would leak
// cross-app data: pool membership, cluster-wide free-id hints. Identity is
// handled by ACCESS_RE. The proxy assigns ids, so nextid is never needed.
const POOLS_RE = /^\/api2\/(?:json|extjs)\/pools(?:\/|$)/
const NEXTID_RE = /^\/api2\/(?:json|extjs)\/cluster\/nextid\/?$/
// Cluster-wide LIST reads: filtered to the key's own VMIDs before returning.
const CLUSTER_RESOURCES_RE = /^\/api2\/(?:json|extjs)\/cluster\/resources\/?$/
const GUEST_LIST_RE = /^\/api2\/(?:json|extjs)\/nodes\/[^/]+\/(?:qemu|lxc)\/?$/
const TASK_LIST_RE = /^\/api2\/(?:json|extjs)\/nodes\/[^/]+\/tasks\/?$/
const STORAGE_CONTENT_RE = /^\/api2\/(?:json|extjs)\/nodes\/[^/]+\/storage\/[^/]+\/content\/?$/

/** UPID:node:pid:pstart:starttime:type:id:user@realm: -> id (vmid for qemu tasks). */
export function vmidFromUpid(upid: string): number | null {
  const parts = decodeURIComponent(upid).split(':')
  if (parts.length < 8 || parts[0] !== 'UPID') return null
  const id = Number.parseInt(parts[6], 10)
  return Number.isInteger(id) && id > 0 ? id : null
}

export function classify(method: string, pathname: string): Classified {
  const out: Classified = {
    opClass: null,
    node: null,
    pathVmid: null,
    upidVmid: null,
    bodyTarget: null,
    listScope: null,
    isTaskPath: false,
    blocked: null,
  }

  if (ACCESS_RE.test(pathname)) {
    out.blocked = 'identity and ACLs are managed by the proxy, not through it'
    return out
  }
  if (POOLS_RE.test(pathname)) {
    out.blocked = 'pools are managed by the proxy, not through it'
    return out
  }
  if (NEXTID_RE.test(pathname)) {
    out.blocked = 'the proxy assigns VMIDs; clone without a newid instead of using nextid'
    return out
  }

  const node = NODE_RE.exec(pathname)
  if (node) out.node = node[1]

  const generic = GENERIC_VMID_RE.exec(pathname)
  if (generic) out.pathVmid = Number.parseInt(generic[1], 10)

  const task = TASK_RE.exec(pathname)
  if (task) {
    out.isTaskPath = true
    out.upidVmid = vmidFromUpid(task[1])
  }

  if (CLUSTER_RESOURCES_RE.test(pathname)) out.listScope = 'resources'
  else if (GUEST_LIST_RE.test(pathname)) out.listScope = 'guests'
  else if (TASK_LIST_RE.test(pathname)) out.listScope = 'tasks'
  else if (STORAGE_CONTENT_RE.test(pathname)) out.listScope = 'storage'

  if (method === 'POST') {
    if (CLONE_RE.test(pathname)) {
      out.opClass = 'clone'
      out.bodyTarget = 'newid'
    } else if (SUSPEND_RE.test(pathname)) {
      out.opClass = 'suspend'
    } else if (MOVE_RE.test(pathname)) {
      // Not a contended pool op, but it names a target VM in the body that must
      // be scope-checked and template-checked before forwarding.
      out.bodyTarget = 'target-vmid'
    }
  } else if (method === 'DELETE' && DELETE_RE.test(pathname)) {
    out.opClass = 'delete'
  }

  return out
}

/**
 * Authorization policy, applied after key auth:
 * - identity/ACL, pool and nextid endpoints are always denied
 * - a task status/log read must resolve to an in-range guest VMID; a task with
 *   no guest VMID (node/cluster task) is denied so an app cannot read cluster
 *   ops logs
 * - reads pass; a read on a VMID outside the key's ranges is denied
 * - writes require a VMID in the path (or a task UPID) inside the ranges;
 *   writes without any VMID are denied (nothing an app needs works that way)
 *
 * The caller must classify() a path that is already percent-decoded, so an
 * encoded VMID cannot slip past pathVmid extraction.
 */
export function authorize(
  method: string,
  cls: Classified,
  allowed: (vmid: number) => boolean,
): string | null {
  if (cls.blocked) return cls.blocked
  const vmid = cls.pathVmid ?? cls.upidVmid
  const isRead = method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
  // A task read is only ever legitimate for the app's own guest tasks: require
  // a scoped guest VMID, never a node/cluster task.
  if (cls.isTaskPath && vmid == null) {
    return 'task is not scoped to a VMID in the ranges of this key'
  }
  if (isRead) {
    if (vmid != null && !allowed(vmid)) return `vmid ${vmid} is outside the ranges of this key`
    return null
  }
  if (vmid == null) return 'writes without a VMID in the path are not allowed through the proxy'
  if (!allowed(vmid)) return `vmid ${vmid} is outside the ranges of this key`
  return null
}
