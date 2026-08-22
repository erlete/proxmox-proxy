import { useEffect, useState, type ReactElement } from 'react'
import { ShieldBan, TriangleAlert } from 'lucide-react'
import { api } from '../api'
import type { paths } from '../api/schema'

type Inventory = paths['/api/inventory']['get']['responses'][200]['content']['application/json']
type Vm = Inventory['reserved'][number]
type Range = [number, number]

type Kind = 'reserved' | 'unassigned'

function vmBadge(vm: Vm): ReactElement {
  if (vm.template) return <span className="badge tpl">template</span>
  const cls = vm.status === 'running' ? 'ok' : vm.status === 'stopped' ? '' : 'warn'
  return <span className={`badge ${cls}`}>{vm.status}</span>
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
        {[...vms]
          .sort((a, b) => a.vmid - b.vmid)
          .map((vm) => (
            <tr key={`${vm.node}-${vm.vmid}`}>
              <td className="mono strong">{vm.vmid}</td>
              <td>{vm.name || <span className="muted">unnamed</span>}</td>
              <td>{vm.node}</td>
              <td>{vmBadge(vm)}</td>
            </tr>
          ))}
      </tbody>
    </table>
  )
}

export function BandSummary({ kind }: { kind: Kind }): ReactElement {
  const [vms, setVms] = useState<Vm[]>([])
  const [reserved, setReserved] = useState<Range[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      const i = await api.GET('/api/inventory')
      if (!alive) return
      if (i.data) setVms(kind === 'reserved' ? i.data.reserved : i.data.unassigned)
      if (kind === 'reserved') {
        const s = await api.GET('/api/settings')
        if (!alive) return
        if (s.data) setReserved(s.data.settings.reserved as Range[])
      }
      setLoading(false)
    }
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [kind])

  if (loading) return <div className="empty">loading</div>

  const title = kind === 'reserved' ? 'Reserved · Summary' : 'Unassigned · Summary'
  const Icon = kind === 'reserved' ? ShieldBan : TriangleAlert

  return (
    <div>
      <h1>{title}</h1>
      <p className="settings-note muted">
        {kind === 'reserved'
          ? 'VMID ranges off-limits to every app. The proxy never touches these VMs, and no app key may overlap the band.'
          : 'Live VMs that fall outside every app range: manual or orphaned residue on the cluster.'}
      </p>

      {kind === 'reserved' && reserved.length > 0 && (
        <div className="chip-row" style={{ marginBottom: 14 }}>
          {reserved.map(([a, b]) => (
            <span className="chip mono" key={`${a}-${b}`}>
              {a === b ? a : `${a} - ${b}`}
            </span>
          ))}
        </div>
      )}

      <section className="card card-section">
        <header>
          <h3>
            <Icon size={14} /> {kind === 'reserved' ? 'Reserved VMs' : 'Unassigned VMs'}
          </h3>
          <span className="hint">{vms.length} VMs</span>
        </header>
        {vms.length === 0 ? <div className="empty small">nothing here</div> : <VmTable vms={vms} />}
      </section>
    </div>
  )
}

export function BandOperations({ kind }: { kind: Kind }): ReactElement {
  return (
    <div>
      <h1>{kind === 'reserved' ? 'Reserved · Operations' : 'Unassigned · Operations'}</h1>
      <div className="empty card">
        <ShieldBan size={26} className="muted" />
        <div>
          <div className="strong">No operations</div>
          <div className="muted">
            {kind === 'reserved'
              ? 'This band is off-limits, so the proxy performs no operations on it.'
              : 'These VMs belong to no app, so the proxy does not operate them.'}
          </div>
        </div>
      </div>
    </div>
  )
}
