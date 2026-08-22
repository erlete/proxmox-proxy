import type { Db } from '../db.js'

export interface VlanLease {
  /** The 802.1q VLAN tag leased to a linked-clone group. */
  vlan: number
  /** VMIDs sharing this VLAN. The lease is freed once none of them exist. */
  vmids: number[]
  keyName: string
  node: string
  createdAt: number
}

/**
 * Durable registry of VLAN tags the proxy handed to linked-clone groups. It is
 * the source of truth for what is in use inside the configured linked-VLAN
 * range, so allocation never scans VM configs. Leases are reaped (see the
 * reaper in linkedclone.ts) when their VMs are gone, which is how a torn-down
 * pod frees its VLAN without any explicit release call.
 */
export class VlanLeaseStore {
  constructor(private db: Db) {}

  create(lease: VlanLease): void {
    this.db
      .prepare(
        'INSERT INTO vlan_leases (vlan, vmids, key_name, node, created_at) VALUES (?, ?, ?, ?, ?) ' +
          'ON CONFLICT(vlan) DO UPDATE SET vmids = excluded.vmids, key_name = excluded.key_name, ' +
          'node = excluded.node, created_at = excluded.created_at',
      )
      .run(lease.vlan, JSON.stringify(lease.vmids), lease.keyName, lease.node, lease.createdAt)
  }

  list(): VlanLease[] {
    const rows = this.db
      .prepare('SELECT vlan, vmids, key_name, node, created_at FROM vlan_leases ORDER BY vlan')
      .all() as Record<string, unknown>[]
    return rows.map((r) => ({
      vlan: Number(r.vlan),
      vmids: JSON.parse(String(r.vmids)) as number[],
      keyName: String(r.key_name),
      node: String(r.node),
      createdAt: Number(r.created_at),
    }))
  }

  /** The lease on a given VLAN, or null: the group record for that tag. */
  get(vlan: number): VlanLease | null {
    const r = this.db
      .prepare('SELECT vlan, vmids, key_name, node, created_at FROM vlan_leases WHERE vlan = ?')
      .get(vlan) as Record<string, unknown> | undefined
    if (!r) return null
    return {
      vlan: Number(r.vlan),
      vmids: JSON.parse(String(r.vmids)) as number[],
      keyName: String(r.key_name),
      node: String(r.node),
      createdAt: Number(r.created_at),
    }
  }

  /** Tags currently leased: the occupied set within the linked-VLAN range. */
  activeVlans(): Set<number> {
    const rows = this.db.prepare('SELECT vlan FROM vlan_leases').all() as { vlan: number }[]
    return new Set(rows.map((r) => Number(r.vlan)))
  }

  remove(vlan: number): void {
    this.db.prepare('DELETE FROM vlan_leases WHERE vlan = ?').run(vlan)
  }
}
