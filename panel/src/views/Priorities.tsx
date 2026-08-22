import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { ArrowUpNarrowWide } from 'lucide-react'
import { api } from '../api'

/**
 * Admission priority as a value per app. Higher value = more preference; apps
 * are ordered by value (desc) then name (asc). Value 0 means no preference:
 * those apps share the round-robin bottom tier fairly.
 */
export function Priorities(): ReactElement {
  const [apps, setApps] = useState<string[]>([])
  const [saved, setSaved] = useState<Record<string, number>>({})
  const [dirty, setDirty] = useState<Record<string, number>>({})
  const [flash, setFlash] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const [keysRes, sRes] = await Promise.all([api.GET('/api/keys'), api.GET('/api/settings')])
    if (keysRes.data) setApps(keysRes.data.keys.filter((k) => k.enabled).map((k) => k.name))
    if (sRes.data) {
      setSaved(sRes.data.settings.appPriority)
      setDirty({})
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const valueOf = (name: string): number => dirty[name] ?? saved[name] ?? 0
  const setValue = (name: string, raw: string): void => {
    setFlash(false)
    const n = Number.parseInt(raw, 10)
    setDirty((d) => ({ ...d, [name]: Number.isFinite(n) && n > 0 ? n : 0 }))
  }

  // Reorder by value desc, then name asc, live as values change.
  const rows = [...apps].sort((a, b) => valueOf(b) - valueOf(a) || a.localeCompare(b))
  const isDirty = Object.keys(dirty).length > 0

  const save = async (): Promise<void> => {
    setError(null)
    const map: Record<string, number> = {}
    for (const name of apps) {
      const v = valueOf(name)
      if (v > 0) map[name] = v
    }
    const { data, error: apiError } = await api.PUT('/api/settings', {
      body: { appPriority: map } as never,
    })
    if (data) {
      setSaved(data.settings.appPriority)
      setDirty({})
      setFlash(true)
    } else {
      setError((apiError as { message?: string } | undefined)?.message ?? 'save failed')
    }
  }

  return (
    <div>
      <div className="page-head">
        <h1>
          <ArrowUpNarrowWide size={20} className="muted" /> Priorities
        </h1>
        <div className="toolbar">
          <button className="btn primary" disabled={!isDirty} onClick={() => void save()}>
            Save
          </button>
          {flash && <span className="badge ok">saved</span>}
        </div>
      </div>
      <p className="muted settings-note">
        Admission preference per app. Higher value wins; apps sort by value then name. Value 0 means
        no preference: those apps share capacity round-robin. Applied hot on save.
      </p>
      {error && <div className="error">{error}</div>}
      {apps.length === 0 ? (
        <div className="empty card">no apps connected yet</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>order</th>
              <th>app</th>
              <th>priority</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((name, i) => (
              <tr key={name}>
                <td className="mono">{valueOf(name) > 0 ? i + 1 : '-'}</td>
                <td className="strong">{name}</td>
                <td>
                  <input
                    className="priority-value"
                    value={String(valueOf(name))}
                    onChange={(e) => setValue(name, e.target.value)}
                    inputMode="numeric"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
