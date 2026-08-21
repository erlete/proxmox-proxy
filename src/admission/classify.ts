import type { OpClassName } from '../config.js'

export interface Classified {
  opClass: OpClassName | null
  node: string | null
  /** VMID present in the path itself (qemu/lxc segments). */
  pathVmid: number | null
  /** VMID recovered from a task UPID in the path, if any. */
  upidVmid: number | null
  /** Non-null = deny with this reason. */
  blocked: string | null
}

const CLONE_RE = /^\/api2\/(?:json|extjs)\/nodes\/([^/]+)\/qemu\/(\d+)\/clone\/?$/
const DELETE_RE = /^\/api2\/(?:json|extjs)\/nodes\/([^/]+)\/qemu\/(\d+)\/?$/
const SUSPEND_RE = /^\/api2\/(?:json|extjs)\/nodes\/([^/]+)\/qemu\/(\d+)\/status\/suspend\/?$/
const GENERIC_VMID_RE = /\/(?:qemu|lxc)\/(\d+)(?:\/|$)/
const NODE_RE = /^\/api2\/(?:json|extjs)\/nodes\/([^/]+)/
const ACCESS_RE = /^\/api2\/[^/]+\/access(?:\/|$)/
const TASK_RE = /^\/api2\/(?:json|extjs)\/nodes\/[^/]+\/tasks\/([^/]+)/

/** UPID:node:pid:pstart:starttime:type:id:user@realm: -> id (vmid for qemu tasks). */
export function vmidFromUpid(upid: string): number | null {
  const parts = decodeURIComponent(upid).split(':')
  if (parts.length < 8 || parts[0] !== 'UPID') return null
  const id = Number.parseInt(parts[6], 10)
  return Number.isInteger(id) && id > 0 ? id : null
}

export function classify(method: string, pathname: string): Classified {
  const out: Classified = { opClass: null, node: null, pathVmid: null, upidVmid: null, blocked: null }

  if (ACCESS_RE.test(pathname)) {
    out.blocked = 'identity and ACLs are managed by the proxy, not through it'
    return out
  }

  const node = NODE_RE.exec(pathname)
  if (node) out.node = node[1]

  const generic = GENERIC_VMID_RE.exec(pathname)
  if (generic) out.pathVmid = Number.parseInt(generic[1], 10)

  const task = TASK_RE.exec(pathname)
  if (task) out.upidVmid = vmidFromUpid(task[1])

  if (method === 'POST') {
    if (CLONE_RE.test(pathname)) out.opClass = 'clone'
    else if (SUSPEND_RE.test(pathname)) out.opClass = 'suspend'
  } else if (method === 'DELETE' && DELETE_RE.test(pathname)) {
    out.opClass = 'delete'
  }

  return out
}

/**
 * v0 authorization policy, applied after key auth:
 * - identity/ACL endpoints are always denied
 * - reads pass; a read on a VMID outside the key's ranges is denied
 * - writes require a VMID in the path (or a task UPID) inside the ranges;
 *   writes without any VMID are denied (nothing an app needs works that way)
 */
export function authorize(
  method: string,
  cls: Classified,
  allowed: (vmid: number) => boolean,
): string | null {
  if (cls.blocked) return cls.blocked
  const vmid = cls.pathVmid ?? cls.upidVmid
  const isRead = method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
  if (isRead) {
    if (vmid != null && !allowed(vmid)) return `vmid ${vmid} is outside the ranges of this key`
    return null
  }
  if (vmid == null) return 'writes without a VMID in the path are not allowed through the proxy'
  if (!allowed(vmid)) return `vmid ${vmid} is outside the ranges of this key`
  return null
}
