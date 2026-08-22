import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { Boxes, ChevronDown, Lock, Network, RefreshCw, TriangleAlert } from 'lucide-react'
import { api } from '../api'
import type { paths } from '../api/schema'

type Inventory = paths['/api/inventory']['get']['responses'][200]['content']['application/json']
type Vm = Inventory['apps'][number]['vms'][number]
type Leases = paths['/api/leases']['get']['responses'][200]['content']['application/json']
type Lease = Leases['leases'][number]

function statusBadge(status: string): ReactElement {
  const cls = status === 'running' ? 'badge ok' : status === 'stopped' ? 'badge' : 'badge warn'
  return <span className={cls}>{status}</span>
}

function VmTable({ vms }: { vms: Vm[] }): ReactElement {
  return (
    <table>
      <thead>
        <tr>
          <th>vmid</th>
          <th>name</th>
          <th>node</th>
          <th>status</th>
        </tr>
      </thead>
      <tbody>
        {vms.map((vm) => (
          <tr key={`${vm.node}-${vm.vmid}`}>
            <td className="mono strong">{vm.vmid}</td>
            <td>{vm.name || <span className="muted">unnamed</span>}</td>
            <td>{vm.node}</td>
            <td className="inv-status">
              {vm.template ? (
                <span className="badge" title="template: a cloneable image, it has no power state">
                  template
                </span>
              ) : (
                statusBadge(vm.status)
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// A card whose header toggles its body. Reuses the queue-class/queue-head look
// so inventory blocks match the rest of the panel.
function Section({
  icon,
  title,
  meta,
  children,
}: {
  icon: ReactNode
  title: string
  meta: ReactNode
  children: ReactNode
}): ReactElement {
  const [open, setOpen] = useState(true)
  return (
    <section className="card queue-class">
      <button
        type="button"
        className="queue-head collapse-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <h2>
          <ChevronDown size={15} className={`muted chevron${open ? '' : ' closed'}`} />
          {icon} {title}
        </h2>
        <span className="muted">{meta}</span>
      </button>
      {open && children}
    </section>
  )
}

function LeaseTable({ leases }: { leases: Lease[] }): ReactElement {
  return (
    <table>
      <thead>
        <tr>
          <th>vlan</th>
          <th>vmids</th>
          <th>app</th>
          <th>node</th>
        </tr>
      </thead>
      <tbody>
        {leases.map((l) => (
          <tr key={l.vlan}>
            <td className="mono strong">{l.vlan}</td>
            <td className="mono">{l.vmids.join(', ')}</td>
            <td>{l.keyName}</td>
            <td>{l.node}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function Inventory(): ReactElement {
  const [inv, setInv] = useState<Inventory | null>(null)
  const [leases, setLeases] = useState<Lease[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const [{ data }, { data: leaseData }] = await Promise.all([
      api.GET('/api/inventory'),
      api.GET('/api/leases'),
    ])
    if (data) setInv(data)
    if (leaseData) setLeases(leaseData.leases)
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  if (!inv) return <div className="empty">loading</div>

  return (
    <div>
      <div className="page-head">
        <h1>Inventory</h1>
        <button className="btn icon-btn" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={14} className={loading ? 'spin' : ''} />
          Refresh
        </button>
      </div>
      <p className="muted settings-note">
        Live VMs on the cluster, grouped by the app whose key ranges own their VMID. Sourced from
        the cluster itself, so it surfaces machines an app may have lost track of.
      </p>

      {!inv.upstreamOk && (
        <div className="empty card">
          <TriangleAlert size={24} className="muted" />
          <div>
            <div className="strong">Cluster unreadable</div>
            <div className="muted">The proxy could not list cluster resources right now.</div>
          </div>
        </div>
      )}

      {inv.reserved.length > 0 && (
        <Section
          icon={<Lock size={15} className="err-text" />}
          title="Reserved"
          meta={`${inv.reserved.length} off-limits to every app`}
        >
          <VmTable vms={inv.reserved} />
        </Section>
      )}

      {inv.apps.map((app) => (
        <Section
          key={app.name}
          icon={<Boxes size={15} className="muted" />}
          title={app.name}
          meta={`${app.vms.length} ${app.vms.length === 1 ? 'VM' : 'VMs'}`}
        >
          {app.vms.length === 0 ? (
            <div className="empty small">no live VMs in this app&apos;s ranges</div>
          ) : (
            <VmTable vms={app.vms} />
          )}
        </Section>
      ))}

      {inv.unassigned.length > 0 && (
        <Section
          icon={<TriangleAlert size={15} className="warn-text" />}
          title="Unassigned"
          meta={`${inv.unassigned.length} outside every app range (manual or orphaned)`}
        >
          <VmTable vms={inv.unassigned} />
        </Section>
      )}

      {leases.length > 0 && (
        <Section
          icon={<Network size={15} className="muted" />}
          title="Leased VLANs"
          meta={`${leases.length} in use by linked-clone groups`}
        >
          <LeaseTable leases={leases} />
        </Section>
      )}
    </div>
  )
}
