import { useEffect, useState, type ReactElement } from 'react'
import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import { api } from '../api'
import type { paths } from '../api/schema'

type SettingsBody = paths['/api/settings']['get']['responses'][200]['content']['application/json']
type Values = SettingsBody['settings']

interface FieldDef {
  key: Exclude<keyof Values, 'priorityApps'>
  label: string
  hint: string
}

const GROUPS: { title: string; fields: FieldDef[] }[] = [
  {
    title: 'Admission caps (slots held until the Proxmox task finishes)',
    fields: [
      { key: 'cloneCap', label: 'Clone cap', hint: 'concurrent clones; 0 pauses the class' },
      { key: 'deleteCap', label: 'Delete cap', hint: 'concurrent deletes' },
      { key: 'suspendCap', label: 'Suspend cap', hint: 'concurrent suspends' },
    ],
  },
  {
    title: 'Queueing',
    fields: [
      { key: 'maxQueue', label: 'Max queue', hint: 'waiting requests per class before 429' },
      { key: 'maxHoldMs', label: 'Max hold (ms)', hint: 'how long a request waits for a slot' },
      { key: 'taskPollMs', label: 'Task poll (ms)', hint: 'tracked task status interval' },
      { key: 'taskTimeoutMs', label: 'Task timeout (ms)', hint: 'safety release for stuck tasks' },
    ],
  },
  {
    title: 'General',
    fields: [
      { key: 'opsRingMax', label: 'Operation log size', hint: 'rows kept in the history ring' },
      { key: 'sessionTtlHours', label: 'Session TTL (h)', hint: 'panel login lifetime' },
      { key: 'publicWsUrl', label: 'Websocket base URL', hint: 'empty = the upstream origin' },
    ],
  },
]

/**
 * Ordered admission priority. Listed apps are strict tiers in this order; every
 * other app shares the bottom tier round-robin. Empty list = round-robin for
 * all. Edits feed the shared dirty/save flow like any other setting.
 */
function PriorityEditor({
  order,
  knownApps,
  onChange,
}: {
  order: string[]
  knownApps: string[]
  onChange: (next: string[]) => void
}): ReactElement {
  const [pick, setPick] = useState('')
  const move = (i: number, delta: number): void => {
    const j = i + delta
    if (j < 0 || j >= order.length) return
    const next = [...order]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  const add = (): void => {
    const name = pick.trim()
    if (!name || order.includes(name)) return
    onChange([...order, name])
    setPick('')
  }
  const suggestions = knownApps.filter((a) => !order.includes(a))
  return (
    <section className="card settings-group">
      <div className="card-title">Admission priority (manual)</div>
      <p className="hint settings-note">
        Strict tiers in this order; everyone else shares the bottom tier round-robin. Empty = pure
        round-robin fairness. Applied hot on save.
      </p>
      {order.length === 0 ? (
        <div className="empty small">no priority set, all apps share fairly</div>
      ) : (
        <ol className="priority-list">
          {order.map((name, i) => (
            <li key={name} className="priority-item">
              <span className="badge">{i + 1}</span>
              <span className="strong mono">{name}</span>
              <div className="priority-actions">
                <button
                  className="btn small icon-btn"
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                  title="move up"
                >
                  <ArrowUp size={12} />
                </button>
                <button
                  className="btn small icon-btn"
                  disabled={i === order.length - 1}
                  onClick={() => move(i, 1)}
                  title="move down"
                >
                  <ArrowDown size={12} />
                </button>
                <button
                  className="btn small danger icon-btn"
                  onClick={() => onChange(order.filter((n) => n !== name))}
                  title="remove"
                >
                  <X size={12} />
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
      <div className="priority-add">
        <input
          value={pick}
          onChange={(e) => setPick(e.target.value.toLowerCase())}
          placeholder="app name"
          list="known-apps"
          pattern="[a-z0-9][a-z0-9-]+"
        />
        <datalist id="known-apps">
          {suggestions.map((a) => (
            <option value={a} key={a} />
          ))}
        </datalist>
        <button className="btn small icon-btn" onClick={add} disabled={!pick.trim()}>
          <Plus size={13} /> Add
        </button>
        {order.length > 0 && (
          <button className="btn small" onClick={() => onChange([])}>
            Clear
          </button>
        )}
      </div>
    </section>
  )
}

export function Settings(): ReactElement {
  const [values, setValues] = useState<Values | null>(null)
  const [defaults, setDefaults] = useState<Values | null>(null)
  const [dirty, setDirty] = useState<Partial<Values>>({})
  const [knownApps, setKnownApps] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const load = async (): Promise<void> => {
    const [settingsRes, keysRes] = await Promise.all([
      api.GET('/api/settings'),
      api.GET('/api/keys'),
    ])
    if (settingsRes.data) {
      setValues(settingsRes.data.settings)
      setDefaults(settingsRes.data.defaults)
      setDirty({})
    }
    if (keysRes.data) setKnownApps(keysRes.data.keys.map((k) => k.name))
  }

  useEffect(() => {
    void load()
  }, [])

  if (!values || !defaults) return <div className="empty">loading</div>

  const current = { ...values, ...dirty }

  const edit = (key: keyof Values, raw: string): void => {
    setSaved(false)
    if (key === 'publicWsUrl') {
      setDirty((d) => ({ ...d, [key]: raw }))
    } else {
      const n = Number.parseInt(raw, 10)
      setDirty((d) => ({ ...d, [key]: Number.isFinite(n) ? n : (raw as never) }))
    }
  }

  const setPriority = (next: string[]): void => {
    setSaved(false)
    setDirty((d) => ({ ...d, priorityApps: next }))
  }

  const save = async (): Promise<void> => {
    setError(null)
    const {
      data,
      error: apiError,
      response,
    } = await api.PUT('/api/settings', { body: dirty as never })
    if (data) {
      setValues(data.settings)
      setDirty({})
      setSaved(true)
    } else {
      setError(
        (apiError as { message?: string } | undefined)?.message ??
          `save failed (${response.status})`,
      )
    }
  }

  const reset = async (): Promise<void> => {
    if (!window.confirm('Reset every runtime setting to its default?')) return
    setError(null)
    const { data } = await api.POST('/api/settings/reset')
    if (data) {
      setValues(data.settings)
      setDirty({})
      setSaved(true)
    }
  }

  return (
    <div>
      <h1>Settings</h1>
      <p className="muted settings-note">
        Applied hot: no restart needed. Boot-level configuration (upstream, credentials, bind,
        singleton lock) lives in the environment.
      </p>
      {GROUPS.map((group) => (
        <section className="card settings-group" key={group.title}>
          <div className="card-title">{group.title}</div>
          <div className="settings-grid">
            {group.fields.map((f) => (
              <label key={f.key}>
                {f.label}
                <input
                  value={String(current[f.key])}
                  onChange={(e) => edit(f.key, e.target.value)}
                  inputMode={f.key === 'publicWsUrl' ? 'url' : 'numeric'}
                  placeholder={String(defaults[f.key])}
                />
                <span className="hint">
                  {f.hint} (default {f.key === 'publicWsUrl' ? 'empty' : String(defaults[f.key])})
                </span>
              </label>
            ))}
          </div>
        </section>
      ))}
      <PriorityEditor order={current.priorityApps} knownApps={knownApps} onChange={setPriority} />
      {error && <div className="error">{error}</div>}
      <div className="toolbar">
        <button
          className="btn primary"
          disabled={Object.keys(dirty).length === 0}
          onClick={() => void save()}
        >
          Save
        </button>
        <button className="btn" onClick={() => void reset()}>
          Reset to defaults
        </button>
        {saved && <span className="badge ok">saved</span>}
      </div>
    </div>
  )
}
