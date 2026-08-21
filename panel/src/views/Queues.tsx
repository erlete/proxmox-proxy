import { useEffect, useState, type ReactElement } from 'react'
import { Copy, Layers } from 'lucide-react'
import { formatAgo } from '../api'
import { useLive } from '../live'

export function Queues(): ReactElement {
  const { queues, connected } = useLive()
  const [, forceTick] = useState(0)

  useEffect(() => {
    const ticker = setInterval(() => forceTick((n) => n + 1), 1000)
    return () => clearInterval(ticker)
  }, [])

  if (!queues) return <div className="empty">loading</div>

  return (
    <div>
      <h1>
        Queues
        <span className={connected ? 'live-dot on' : 'live-dot'} title={connected ? 'live' : 'reconnecting'} />
      </h1>
      {queues.classes.map((cls) => {
        const pct = cls.cap > 0 ? Math.min(100, (cls.running.length / cls.cap) * 100) : 100
        return (
          <section className="card queue-class" key={cls.name}>
            <div className="queue-head">
              <h2>
                <Layers size={15} className="muted" /> {cls.name}
              </h2>
              <div className="queue-head-meta">
                <span className="muted">
                  {cls.running.length} / {cls.cap} running
                  {cls.waiting.length > 0 ? ` · ${cls.waiting.length} waiting` : ''}
                </span>
                <div className="meter slim">
                  <div
                    className={cls.waiting.length > 0 ? 'meter-fill warn' : 'meter-fill'}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            </div>
            {cls.running.length === 0 && cls.waiting.length === 0 ? (
              <div className="empty small">idle, no heavy operations in flight</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>state</th>
                    <th>app</th>
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
                        <span className="badge ok">
                          <span className="pulse" />
                          running
                        </span>
                      </td>
                      <td className="strong">{r.keyName}</td>
                      <td className="mono">{r.vmid ?? '-'}</td>
                      <td>{r.node ?? '-'}</td>
                      <td className="mono upid" title={r.upid ?? ''}>
                        {r.upid ? (
                          <span
                            className="copyable"
                            onClick={() => void navigator.clipboard.writeText(r.upid ?? '')}
                            title="click to copy the UPID"
                          >
                            {r.upid.slice(0, 30)}... <Copy size={11} />
                          </span>
                        ) : (
                          'starting'
                        )}
                      </td>
                      <td>{formatAgo(r.taskStartedAt ?? r.grantedAt)}</td>
                    </tr>
                  ))}
                  {cls.waiting.map((w) => (
                    <tr key={`w${w.id}`} className="dim">
                      <td>
                        <span className="badge warn">waiting</span>
                      </td>
                      <td className="strong">{w.keyName}</td>
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
        )
      })}
    </div>
  )
}
