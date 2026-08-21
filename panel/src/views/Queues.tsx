import { useEffect, useState, type ReactElement } from 'react'
import { api, formatAgo } from '../api'
import type { paths } from '../api/schema'

type Queues = paths['/api/queues']['get']['responses'][200]['content']['application/json']

export function Queues(): ReactElement {
  const [snapshot, setSnapshot] = useState<Queues | null>(null)
  const [live, setLive] = useState(false)
  const [, forceTick] = useState(0)

  useEffect(() => {
    // Initial snapshot via REST, then live updates over SSE.
    void api.GET('/api/queues').then(({ data }) => {
      if (data) setSnapshot(data)
    })
    const es = new EventSource('/api/events')
    es.addEventListener('queues', (e) => {
      setSnapshot(JSON.parse((e as MessageEvent).data) as Queues)
      setLive(true)
    })
    es.onopen = () => setLive(true)
    es.onerror = () => setLive(false)
    const ticker = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => {
      es.close()
      clearInterval(ticker)
    }
  }, [])

  if (!snapshot) return <div className="empty">loading</div>

  return (
    <div>
      <h1>
        Queues
        <span className={live ? 'live-dot on' : 'live-dot'} title={live ? 'live' : 'reconnecting'} />
      </h1>
      {snapshot.classes.map((cls) => (
        <section className="queue-class" key={cls.name}>
          <h2>
            {cls.name}
            <span className="muted">
              {' '}
              {cls.running.length} / {cls.cap} running, {cls.waiting.length} waiting
            </span>
          </h2>
          {cls.running.length === 0 && cls.waiting.length === 0 ? (
            <div className="empty small">idle</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>state</th>
                  <th>key</th>
                  <th>vmid</th>
                  <th>node</th>
                  <th>task</th>
                  <th>elapsed</th>
                </tr>
              </thead>
              <tbody>
                {cls.running.map((r) => (
                  <tr key={`r${r.id}`}>
                    <td>
                      <span className="badge ok">running</span>
                    </td>
                    <td>{r.keyName}</td>
                    <td className="mono">{r.vmid ?? '-'}</td>
                    <td>{r.node ?? '-'}</td>
                    <td className="mono upid" title={r.upid ?? ''}>
                      {r.upid ? `${r.upid.slice(0, 34)}...` : 'starting'}
                    </td>
                    <td>{formatAgo(r.taskStartedAt ?? r.grantedAt)}</td>
                  </tr>
                ))}
                {cls.waiting.map((w) => (
                  <tr key={`w${w.id}`} className="dim">
                    <td>
                      <span className="badge warn">waiting</span>
                    </td>
                    <td>{w.keyName}</td>
                    <td className="mono">{w.vmid ?? '-'}</td>
                    <td>-</td>
                    <td>-</td>
                    <td>{formatAgo(w.enqueuedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </div>
  )
}
