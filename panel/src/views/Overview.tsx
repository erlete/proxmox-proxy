import { useEffect, useState, type ReactElement } from 'react'
import { Activity, Server, ShieldAlert, ShieldCheck, Waypoints } from 'lucide-react'
import { api, formatAgo, formatTs } from '../api'
import { useLive } from '../live'
import type { paths } from '../api/schema'

type Status = paths['/api/status']['get']['responses'][200]['content']['application/json']
type OpRows = paths['/api/operations']['get']['responses'][200]['content']['application/json']['rows']

export function Overview(): ReactElement {
  const [status, setStatus] = useState<Status | null>(null)
  const [ops, setOps] = useState<OpRows>([])
  const [error, setError] = useState<string | null>(null)
  const { queues } = useLive()

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      const [statusRes, opsRes] = await Promise.all([
        api.GET('/api/status'),
        api.GET('/api/operations', { params: { query: { limit: 500 } } }),
      ])
      if (!alive) return
      if (statusRes.data) {
        setStatus(statusRes.data)
        setError(null)
      } else if (statusRes.response.status !== 401) {
        setError(`status unavailable (${statusRes.response.status})`)
      }
      if (opsRes.data) setOps(opsRes.data.rows)
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

  const admission = queues
    ? queues.classes.map((c) => ({
        name: c.name,
        cap: c.cap,
        active: c.running.length,
        waiting: c.waiting.length,
      }))
    : status.admission

  return (
    <div>
      <h1>Overview</h1>
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
            {status.upstream.version ? `Proxmox VE ${status.upstream.version}` : status.upstream.error}
          </div>
          <div className="muted">checked {formatAgo(status.upstream.checkedAt)} ago</div>
        </div>
        <div className="card stat-card">
          <div className="card-head">
            <div className="card-title">Singleton</div>
            {status.singleton.held || !status.singleton.enabled ? (
              <ShieldCheck size={16} className="card-icon ok" />
            ) : (
              <ShieldAlert size={16} className="card-icon err" />
            )}
          </div>
          <div className={status.singleton.held || !status.singleton.enabled ? 'stat ok' : 'stat err'}>
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

      <h2>Admission</h2>
      <div className="cards">
        {admission.map((cls) => {
          const pct = cls.cap > 0 ? Math.min(100, (cls.active / cls.cap) * 100) : 100
          return (
            <div className="card meter-card" key={cls.name}>
              <div className="card-head">
                <div className="card-title">{cls.name}</div>
                <span className={cls.waiting > 0 ? 'badge warn' : cls.active > 0 ? 'badge ok' : 'badge'}>
                  {cls.active > 0 || cls.waiting > 0 ? 'busy' : 'idle'}
                </span>
              </div>
              <div className="meter-row">
                <span className="stat small">
                  {cls.active}
                  <span className="muted"> / {cls.cap}</span>
                </span>
                {cls.waiting > 0 && <span className="warn-text">{cls.waiting} waiting</span>}
              </div>
              <div className="meter">
                <div
                  className={cls.waiting > 0 ? 'meter-fill warn' : 'meter-fill'}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
