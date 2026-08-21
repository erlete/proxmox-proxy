import { useEffect, useState, type ReactElement } from 'react'
import { api } from '../api'
import type { paths } from '../api/schema'

type SettingsBody = paths['/api/settings']['get']['responses'][200]['content']['application/json']
type Values = SettingsBody['settings']

interface FieldDef {
  key: keyof Values
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

export function Settings(): ReactElement {
  const [values, setValues] = useState<Values | null>(null)
  const [defaults, setDefaults] = useState<Values | null>(null)
  const [dirty, setDirty] = useState<Partial<Values>>({})
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const load = async (): Promise<void> => {
    const { data } = await api.GET('/api/settings')
    if (data) {
      setValues(data.settings)
      setDefaults(data.defaults)
      setDirty({})
    }
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

  const save = async (): Promise<void> => {
    setError(null)
    const { data, error: apiError, response } = await api.PUT('/api/settings', {
      body: dirty as never,
    })
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
    const { data } = await api.PUT('/api/settings', { body: defaults as never })
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
      {error && <div className="error">{error}</div>}
      <div className="toolbar">
        <button className="btn primary" disabled={Object.keys(dirty).length === 0} onClick={() => void save()}>
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
