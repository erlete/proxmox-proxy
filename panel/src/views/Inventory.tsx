import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { Boxes, HardDrive, RefreshCw, TriangleAlert } from 'lucide-react'
import { api } from '../api'
import type { paths } from '../api/schema'

type Inventory = paths['/api/inventory']['get']['responses'][200]['content']['application/json']
type Vm = Inventory['apps'][number]['vms'][number]

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
            <td>{statusBadge(vm.status)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function Inventory(): ReactElement {
  const [inv, setInv] = useState<Inventory | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    const { data } = await api.GET('/api/inventory')
    if (data) setInv(data)
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

      {inv.apps.map((app) => (
        <section className="card queue-class" key={app.name}>
          <div className="queue-head">
            <h2>
              <Boxes size={15} className="muted" /> {app.name}
            </h2>
            <span className="muted">
              {app.vms.length} {app.vms.length === 1 ? 'VM' : 'VMs'}
            </span>
          </div>
          {app.vms.length === 0 ? (
            <div className="empty small">no live VMs in this app&apos;s ranges</div>
          ) : (
            <VmTable vms={app.vms} />
          )}
        </section>
      ))}

      {inv.unassigned.length > 0 && (
        <section className="card queue-class">
          <div className="queue-head">
            <h2>
              <TriangleAlert size={15} className="warn-text" /> Unassigned
            </h2>
            <span className="muted">
              {inv.unassigned.length} outside every app range (manual or orphaned)
            </span>
          </div>
          <VmTable vms={inv.unassigned} />
        </section>
      )}
    </div>
  )
}
