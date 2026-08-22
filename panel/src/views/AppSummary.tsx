import { useEffect, useState, type ReactElement } from 'react'
import { Boxes, History, KeyRound, Network } from 'lucide-react'
import { api, formatAgo } from '../api'
import type { paths } from '../api/schema'

type Inventory = paths['/api/inventory']['get']['responses'][200]['content']['application/json']
type Vm = Inventory['apps'][number]['vms'][number]
type AppRow =
  paths['/api/keys']['get']['responses'][200]['content']['application/json']['keys'][number]
type OpRows =
  paths['/api/operations']['get']['responses'][200]['content']['application/json']['rows']
type Leases = paths['/api/leases']['get']['responses'][200]['content']['application/json']['leases']

function vmBadge(vm: Vm): ReactElement {
  if (vm.template) return <span className="badge tpl">template</span>
  const cls = vm.status === 'running' ? 'ok' : vm.status === 'stopped' ? '' : 'warn'
  return <span className={`badge ${cls}`}>{vm.status}</span>
}

function codeClass(status: number | null): string {
  if (status == null) return 'warn'
  if (status < 400) return 'ok'
  if (status === 429) return 'warn'
  return 'err'
}

export function AppSummary({ name }: { name: string }): ReactElement {
  const [key, setKey] = useState<AppRow | null>(null)
  const [vms, setVms] = useState<Vm[]>([])
  const [ranges, setRanges] = useState<[number, number][]>([])
  const [leases, setLeases] = useState<Leases>([])
  const [ops, setOps] = useState<OpRows>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      const [k, i, l, o] = await Promise.all([
        api.GET('/api/keys'),
        api.GET('/api/inventory'),
        api.GET('/api/leases'),
        api.GET('/api/operations', { params: { query: { limit: 500, key: name } } }),
      ])
      if (!alive) return
      if (k.data) setKey(k.data.keys.find((x) => x.name === name) ?? null)
      if (i.data) {
        const app = i.data.apps.find((a) => a.name === name)
        setVms(app?.vms ?? [])
        setRanges((app?.vmidRanges ?? []) as [number, number][])
      }
      if (l.data) setLeases(l.data.leases.filter((x) => x.keyName === name))
      if (o.data) setOps(o.data.rows)
      setLoading(false)
    }
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [name])

  if (loading) return <div className="empty">loading</div>

  const running = vms.filter((v) => v.status === 'running' && !v.template).length
  const templates = vms.filter((v) => v.template).length

  return (
    <div>
      <h1>{name} · Summary</h1>
      <p className="settings-note muted">
        App key scoped to its VMID ranges. The proxy shows this app only its own resources.
      </p>

      <div className="cards">
        <div className="card stat-card">
          <div className="card-head">
            <div className="card-title">Ranges</div>
            <KeyRound size={16} className="card-icon" />
          </div>
          <div className="chip-row" style={{ marginTop: 2 }}>
            {ranges.map(([a, b]) => (
              <span className="chip mono" key={`${a}-${b}`}>
                {a} - {b}
              </span>
            ))}
          </div>
        </div>
        <div className="card stat-card">
          <div className="card-head">
            <div className="card-title">Live VMs</div>
            <Boxes size={16} className="card-icon" />
          </div>
          <div className="stat">{vms.length}</div>
          <div className="muted">
            {running} running · {templates} template{templates === 1 ? '' : 's'}
          </div>
        </div>
        <div className="card stat-card">
          <div className="card-head">
            <div className="card-title">Leased VLANs</div>
            <Network size={16} className="card-icon" />
          </div>
          <div className="stat">{leases.length}</div>
          <div className="muted">{leases.length ? 'linked-clone pods' : 'no pods up'}</div>
        </div>
        <div className="card stat-card">
          <div className="card-head">
            <div className="card-title">Key</div>
          </div>
          <div className={key?.enabled ? 'stat ok' : 'stat err'} style={{ fontSize: 16 }}>
            {key?.enabled ? 'enabled' : 'revoked'}
          </div>
          <div className="muted">
            {key?.lastUsedAt ? `active ${formatAgo(key.lastUsedAt)} ago` : 'never seen'}
          </div>
        </div>
      </div>

      <div className="grid2">
        <section className="card card-section">
          <header>
            <h3>
              <Boxes size={14} /> Machines
            </h3>
            <span className="hint">{vms.length}</span>
          </header>
          {vms.length === 0 ? (
            <div className="empty small">no live VMs in this app&apos;s ranges</div>
          ) : (
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
          )}
        </section>
        <div>
          <section className="card card-section">
            <header>
              <h3>
                <Network size={14} /> Leased VLANs
              </h3>
            </header>
            {leases.length === 0 ? (
              <div className="empty small">no leased VLANs</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>vlan</th>
                    <th>pod</th>
                  </tr>
                </thead>
                <tbody>
                  {leases.map((l) => (
                    <tr key={l.vlan}>
                      <td className="mono strong">{l.vlan}</td>
                      <td className="mono">{l.vmids.join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          <section className="card card-section">
            <header>
              <h3>
                <History size={14} /> Recent operations
              </h3>
            </header>
            {ops.length === 0 ? (
              <div className="empty small">nothing recorded for this app</div>
            ) : (
              <div className="ops-feed">
                {ops.slice(0, 8).map((o) => (
                  <div className="op" key={o.id}>
                    <span className={`op-code ${codeClass(o.status)}`}>{o.status ?? '-'}</span>
                    <span className="op-what">
                      <b>{o.opClass ?? o.method}</b> {o.vmid ? o.vmid : (o.note ?? '')}
                    </span>
                    <span className="op-when">{formatAgo(o.ts)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
