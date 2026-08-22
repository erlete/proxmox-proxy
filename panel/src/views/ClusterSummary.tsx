import { useEffect, useMemo, useState, type ReactElement } from 'react'
import {
  Activity,
  History,
  Network,
  Server,
  ShieldAlert,
  ShieldCheck,
  Waypoints,
} from 'lucide-react'
import { api, formatAgo, formatTs } from '../api'
import { useLive } from '../live'
import type { paths } from '../api/schema'

type Status = paths['/api/status']['get']['responses'][200]['content']['application/json']
type OpRows =
  paths['/api/operations']['get']['responses'][200]['content']['application/json']['rows']
type Leases = paths['/api/leases']['get']['responses'][200]['content']['application/json']['leases']

function codeClass(status: number | null): string {
  if (status == null) return 'warn'
  if (status < 400) return 'ok'
  if (status === 429) return 'warn'
  return 'err'
}

/** Compact area chart of operations per 5-minute bucket over the last hour. */
function Throughput({ ops }: { ops: OpRows }): ReactElement {
  const buckets = useMemo(() => {
    const now = Date.now()
    const b = new Array(12).fill(0) as number[]
    for (const o of ops) {
      const age = now - o.ts
      if (age < 0 || age > 3_600_000) continue
      const idx = 11 - Math.min(11, Math.floor(age / 300_000))
      b[idx] += 1
    }
    return b
  }, [ops])
  const W = 640
  const H = 128
  const pad = 8
  const max = Math.max(4, ...buckets)
  const n = buckets.length
  const x = (i: number): number => pad + (i * (W - 2 * pad)) / (n - 1)
  const y = (v: number): number => H - 16 - (v / max) * (H - 28)
  let line = ''
  let area = `M ${x(0)} ${H - 16}`
  buckets.forEach((v, i) => {
    line += `${i ? 'L' : 'M'}${x(i)} ${y(v)} `
    area += `L ${x(i)} ${y(v)} `
  })
  area += `L ${x(n - 1)} ${H - 16} Z`
  const grid = [0, 1, 2, 3].map((g) => {
    const gy = 16 + g * ((H - 32) / 3)
    return <line key={g} x1={pad} y1={gy} x2={W - pad} y2={gy} stroke="#2f2f2f" strokeWidth={1} />
  })
  return (
    <svg
      className="area"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Throughput"
    >
      <defs>
        <linearGradient id="tp" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#e57000" stopOpacity="0.42" />
          <stop offset="1" stopColor="#e57000" stopOpacity="0" />
        </linearGradient>
      </defs>
      {grid}
      <path d={area} fill="url(#tp)" />
      <path
        d={line}
        fill="none"
        stroke="#f0821a"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle
        cx={x(n - 1)}
        cy={y(buckets[n - 1])}
        r={3.6}
        fill="#fff"
        stroke="#e57000"
        strokeWidth={2}
      />
    </svg>
  )
}

export function ClusterSummary(): ReactElement {
  const [status, setStatus] = useState<Status | null>(null)
  const [ops, setOps] = useState<OpRows>([])
  const [leases, setLeases] = useState<Leases>([])
  const [error, setError] = useState<string | null>(null)
  const { queues } = useLive()

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      const [s, o, l] = await Promise.all([
        api.GET('/api/status'),
        api.GET('/api/operations', { params: { query: { limit: 500 } } }),
        api.GET('/api/leases'),
      ])
      if (!alive) return
      if (s.data) {
        setStatus(s.data)
        setError(null)
      } else if (s.response.status !== 401) {
        setError(`status unavailable (${s.response.status})`)
      }
      if (o.data) setOps(o.data.rows)
      if (l.data) setLeases(l.data.leases)
    }
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  if (error) return <div className="empty">{error}</div>
  if (!status) return <div className="empty">loading</div>

  const hourAgo = Date.now() - 3_600_000
  const lastHour = ops.filter((o) => o.ts >= hourAgo)
  const denied = lastHour.filter((o) => o.status === 403 || o.status === 429).length
  const heavy = lastHour.filter((o) => o.opClass != null).length
  const singletonOk = status.singleton.held || !status.singleton.enabled
  const admission = queues
    ? queues.classes.map((c) => ({
        name: c.name,
        cap: c.cap,
        effectiveCap: c.effectiveCap,
        outOfBand: c.outOfBand,
        active: c.running.length,
        waiting: c.waiting.length,
      }))
    : status.admission.map((c) => ({ ...c, effectiveCap: c.effectiveCap, outOfBand: c.outOfBand }))

  return (
    <div>
      <h1>liga · Summary</h1>
      <p className="settings-note muted">
        Single admission authority in front of Proxmox VE {status.upstream.version ?? '(unknown)'}.
      </p>

      <div className="cards">
        <div className="card stat-card">
          <div className="card-head">
            <div className="card-title">Upstream</div>
            <Server size={16} className="card-icon" />
          </div>
          <div className={status.upstream.ok ? 'stat ok' : 'stat err'}>
            {status.upstream.ok ? 'reachable' : 'unreachable'}
          </div>
          <div className="muted">
            {status.upstream.version
              ? `Proxmox VE ${status.upstream.version}`
              : status.upstream.error}
          </div>
          <div className="muted">checked {formatAgo(status.upstream.checkedAt)} ago</div>
        </div>
        <div className="card stat-card">
          <div className="card-head">
            <div className="card-title">Singleton</div>
            {singletonOk ? (
              <ShieldCheck size={16} className="card-icon ok" />
            ) : (
              <ShieldAlert size={16} className="card-icon err" />
            )}
          </div>
          <div className={singletonOk ? 'stat ok' : 'stat err'}>
            {status.singleton.enabled ? (status.singleton.held ? 'held' : 'LOST') : 'disabled'}
          </div>
          <div className="muted mono">{status.singleton.instanceId.slice(0, 13)}</div>
          <div className="muted">the only proxy guarding this cluster</div>
        </div>
        <div className="card stat-card">
          <div className="card-head">
            <div className="card-title">Proxy</div>
            <Waypoints size={16} className="card-icon" />
          </div>
          <div className="stat">{status.version}</div>
          <div className="muted">up {formatAgo(status.startedAt)}</div>
          <div className="muted">since {formatTs(status.startedAt)}</div>
        </div>
        <div className="card stat-card">
          <div className="card-head">
            <div className="card-title">Last hour</div>
            <Activity size={16} className="card-icon" />
          </div>
          <div className="stat">{lastHour.length}</div>
          <div className="muted">
            {heavy} heavy · {denied > 0 ? `${denied} denied/throttled` : 'nothing denied'}
          </div>
          <div className="muted">recorded operations</div>
        </div>
      </div>

      <div className="grid2">
        <div>
          <section className="card card-section">
            <header>
              <h3>
                <Activity size={14} /> Admission throughput
              </h3>
              <span className="hint">last 60 min · ops / 5 min</span>
            </header>
            <div className="chart-wrap">
              <Throughput ops={ops} />
            </div>
          </section>
          <section className="card card-section">
            <header>
              <h3>Admission classes</h3>
              <span className="hint">active / effective cap</span>
            </header>
            {admission.map((c) => {
              const cap = c.effectiveCap
              const pct = cap > 0 ? Math.min(100, (c.active / cap) * 100) : c.active > 0 ? 100 : 0
              return (
                <div className="gauge" key={c.name}>
                  <div className="g-name">
                    {c.name}
                    <span>
                      {c.cap} cap{c.outOfBand > 0 ? ` · ${c.outOfBand} out-of-band` : ''}
                    </span>
                  </div>
                  <div className="meter">
                    <div
                      className={c.waiting > 0 ? 'meter-fill warn' : 'meter-fill'}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div className="g-num">
                    {c.active}
                    <small>/{cap}</small>
                  </div>
                </div>
              )
            })}
          </section>
        </div>
        <div>
          <section className="card card-section">
            <header>
              <h3>
                <Network size={14} /> Leased VLANs
              </h3>
              <span className="hint">{leases.length} in use</span>
            </header>
            {leases.length === 0 ? (
              <div className="empty small">no linked-clone pods up</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>vlan</th>
                    <th>pod</th>
                    <th>app</th>
                  </tr>
                </thead>
                <tbody>
                  {leases.map((l) => (
                    <tr key={l.vlan}>
                      <td className="mono strong">{l.vlan}</td>
                      <td className="mono">{l.vmids.join(', ')}</td>
                      <td>{l.keyName}</td>
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
              <span className="hint">latest 8</span>
            </header>
            {ops.length === 0 ? (
              <div className="empty small">nothing recorded yet</div>
            ) : (
              <div className="ops-feed">
                {ops.slice(0, 8).map((o) => (
                  <div className="op" key={o.id}>
                    <span className={`op-code ${codeClass(o.status)}`}>{o.status ?? '-'}</span>
                    <span className="op-what">
                      <b>{o.opClass ?? o.method}</b> {o.vmid ? o.vmid : (o.note ?? '')} ·{' '}
                      {o.keyName}
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
