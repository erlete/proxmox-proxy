import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { RefreshCw } from 'lucide-react'
import { api, formatAgo, formatMs, formatTs } from '../api'
import type { paths } from '../api/schema'

type Operations = paths['/api/operations']['get']['responses'][200]['content']['application/json']
type Row = Operations['rows'][number]

function statusBadge(row: Row): ReactElement {
  if (row.status == null) return <span className="badge">-</span>
  const cls = row.status < 400 ? 'ok' : row.status === 429 ? 'warn' : 'err'
  return <span className={`badge ${cls}`}>{row.status}</span>
}

function methodChip(method: string): ReactElement {
  const cls =
    method === 'GET'
      ? 'chip'
      : method === 'DELETE'
        ? 'chip err'
        : method === 'POST'
          ? 'chip accent'
          : 'chip warn'
  return <span className={cls}>{method}</span>
}

export function Operations({
  initialKey = '',
  lockKey = false,
}: {
  initialKey?: string
  lockKey?: boolean
} = {}): ReactElement {
  const [rows, setRows] = useState<Row[]>([])
  const [opClass, setOpClass] = useState('')
  const [key, setKey] = useState(initialKey)
  const [auto, setAuto] = useState(true)

  const load = useCallback(async (): Promise<void> => {
    const { data } = await api.GET('/api/operations', {
      params: {
        query: {
          limit: 200,
          ...(opClass ? { opClass } : {}),
          ...(key ? { key } : {}),
        },
      },
    })
    if (data) setRows(data.rows)
  }, [opClass, key])

  useEffect(() => {
    void load()
    if (!auto) return
    const timer = setInterval(() => void load(), 5000)
    return () => clearInterval(timer)
  }, [load, auto])

  return (
    <div>
      <h1>{lockKey && initialKey ? `${initialKey} · Operations` : 'Operations'}</h1>
      <div className="toolbar">
        <select value={opClass} onChange={(e) => setOpClass(e.target.value)}>
          <option value="">all classes</option>
          <option value="clone">clone</option>
          <option value="delete">delete</option>
          <option value="suspend">suspend</option>
        </select>
        {!lockKey && (
          <input placeholder="filter by app" value={key} onChange={(e) => setKey(e.target.value)} />
        )}
        <label className="check">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          auto-refresh
        </label>
        <button className="btn icon-btn" onClick={() => void load()}>
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="empty">no operations recorded</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>when</th>
              <th>app</th>
              <th>request</th>
              <th>class</th>
              <th>vmid</th>
              <th>status</th>
              <th>queue</th>
              <th>http</th>
              <th>task</th>
              <th>note</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="nowrap" title={formatTs(row.ts)}>
                  {formatAgo(row.ts)} ago
                </td>
                <td className="strong">{row.keyName}</td>
                <td className="mono path" title={row.path}>
                  {methodChip(row.method)} {row.path.replace('/api2/json', '')}
                </td>
                <td>{row.opClass ? <span className="chip accent">{row.opClass}</span> : '-'}</td>
                <td className="mono">{row.vmid ?? '-'}</td>
                <td>{statusBadge(row)}</td>
                <td className={row.queueMs != null && row.queueMs > 1000 ? 'warn-text' : ''}>
                  {formatMs(row.queueMs)}
                </td>
                <td>{formatMs(row.durationMs)}</td>
                <td>{formatMs(row.taskMs)}</td>
                <td className="muted">{row.note ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
