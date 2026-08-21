import { useEffect, useState, type ReactElement } from 'react'
import { api, formatAgo, formatTs } from '../api'
import type { paths } from '../api/schema'

type Status = paths['/api/status']['get']['responses'][200]['content']['application/json']

export function Overview(): ReactElement {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      const { data, response } = await api.GET('/api/status')
      if (!alive) return
      if (data) {
        setStatus(data)
        setError(null)
      } else if (response.status !== 401) {
        setError(`status unavailable (${response.status})`)
      }
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

  return (
    <div>
      <h1>Overview</h1>
      <div className="cards">
        <div className="card">
          <div className="card-title">Upstream</div>
          <div className={status.upstream.ok ? 'stat ok' : 'stat err'}>
            {status.upstream.ok ? 'reachable' : 'unreachable'}
          </div>
          <div className="muted">
            {status.upstream.version ? `pve ${status.upstream.version}` : status.upstream.error}
          </div>
          <div className="muted">checked {formatAgo(status.upstream.checkedAt)} ago</div>
        </div>
        <div className="card">
          <div className="card-title">Singleton</div>
          <div className={status.singleton.held || !status.singleton.enabled ? 'stat ok' : 'stat err'}>
            {status.singleton.enabled ? (status.singleton.held ? 'held' : 'LOST') : 'disabled'}
          </div>
          <div className="muted mono">{status.singleton.instanceId.slice(0, 13)}</div>
        </div>
        <div className="card">
          <div className="card-title">Proxy</div>
          <div className="stat">{status.version}</div>
          <div className="muted">up {formatAgo(status.startedAt)}</div>
          <div className="muted">since {formatTs(status.startedAt)}</div>
        </div>
      </div>
      <h2>Admission</h2>
      <div className="cards">
        {status.admission.map((cls) => (
          <div className="card" key={cls.name}>
            <div className="card-title">{cls.name}</div>
            <div className={cls.waiting > 0 ? 'stat warn' : 'stat'}>
              {cls.active} / {cls.cap}
            </div>
            <div className="muted">
              {cls.waiting > 0 ? `${cls.waiting} waiting` : 'no queue'}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
