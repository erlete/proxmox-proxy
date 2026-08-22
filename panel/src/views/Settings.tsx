import { useEffect, useState, type ReactElement } from 'react'
import { Network, Plus, ShieldBan, X } from 'lucide-react'
import { api } from '../api'
import type { paths } from '../api/schema'

type SettingsBody = paths['/api/settings']['get']['responses'][200]['content']['application/json']
type Values = SettingsBody['settings']
type Range = [number, number]

interface FieldDef {
  key: Exclude<keyof Values, 'appPriority' | 'reserved' | 'linkedVlanRange'>
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

/** Accepts "100" (a single VMID) or "1100000-1100999" (a range). */
function parseRange(text: string): Range | null {
  const t = text.trim()
  const single = /^(\d+)$/.exec(t)
  if (single) {
    const n = Number.parseInt(single[1], 10)
    return n >= 100 ? [n, n] : null
  }
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(t)
  if (!m) return null
  const min = Number.parseInt(m[1], 10)
  const max = Number.parseInt(m[2], 10)
  return min >= 100 && max >= min ? [min, max] : null
}

/**
 * Linked-VLAN range: the tag pool the proxy leases from when it clones a linked
 * group onto one isolated VLAN. Empty disables linked cloning.
 */
function LinkedVlanEditor({
  value,
  onChange,
}: {
  value: Range | null
  onChange: (next: Range | null) => void
}): ReactElement {
  const [text, setText] = useState(value ? `${value[0]}-${value[1]}` : '')
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    setText(value ? `${value[0]}-${value[1]}` : '')
  }, [value])
  const apply = (): void => {
    const t = text.trim()
    if (t === '') {
      setErr(null)
      onChange(null)
      return
    }
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(t)
    if (!m) {
      setErr('Enter a range like 1000-1099, or clear to disable')
      return
    }
    const a = Number.parseInt(m[1], 10)
    const b = Number.parseInt(m[2], 10)
    if (a < 1 || b > 4094 || a > b) {
      setErr('Tags must satisfy 1 <= start <= end <= 4094')
      return
    }
    setErr(null)
    onChange([a, b])
  }
  return (
    <section className="card settings-group">
      <div className="card-title">
        <Network size={13} className="muted" /> Linked-clone VLAN range
      </div>
      <p className="hint settings-note">
        Tag pool the proxy leases from to isolate each linked-clone group on its own VLAN. Must not
        collide with the platform&apos;s default per-VM tags. Empty disables linked cloning through
        the proxy. Applied hot on save.
      </p>
      <div className="priority-add">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="1000-1099 (empty = disabled)"
          inputMode="numeric"
          onKeyDown={(e) => {
            if (e.key === 'Enter') apply()
          }}
        />
        <button className="btn small icon-btn" onClick={apply}>
          <Plus size={13} /> Set
        </button>
      </div>
      <span className="hint">
        Current: {value ? `${value[0]} - ${value[1]}` : 'disabled'}. Valid tags 1 to 4094.
      </span>
      {err && <div className="error">{err}</div>}
    </section>
  )
}

/**
 * Reserved VMIDs: ranges no app key may include. Enforced as configuration (a
 * key whose ranges would overlap one is rejected), not per operation.
 */
function ReservedEditor({
  ranges,
  onChange,
}: {
  ranges: Range[]
  onChange: (next: Range[]) => void
}): ReactElement {
  const [text, setText] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const add = (): void => {
    const r = parseRange(text)
    if (!r) {
      setErr('Enter a VMID (100) or a range (1100000-1100999); min 100')
      return
    }
    setErr(null)
    if (!ranges.some(([a, b]) => a === r[0] && b === r[1])) onChange([...ranges, r])
    setText('')
  }
  return (
    <section className="card settings-group">
      <div className="card-title">
        <ShieldBan size={13} className="muted" /> Reserved VMIDs
      </div>
      <p className="hint settings-note">
        Ranges no app key may include: a key whose ranges would overlap one of these is rejected, so
        an app can never even name a reserved VMID. Shown in the inventory. Applied hot on save.
      </p>
      {ranges.length === 0 ? (
        <div className="empty small">nothing reserved</div>
      ) : (
        <div className="chip-row">
          {ranges.map(([a, b]) => (
            <span className="chip mono reserved-chip" key={`${a}-${b}`}>
              {a === b ? a : `${a} - ${b}`}
              <button
                className="chip-x"
                title="remove"
                onClick={() => onChange(ranges.filter(([x, y]) => !(x === a && y === b)))}
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="priority-add">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="100 or 1100000-1100999"
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
        />
        <button className="btn small icon-btn" onClick={add} disabled={!text.trim()}>
          <Plus size={13} /> Reserve
        </button>
      </div>
      {err && <div className="error">{err}</div>}
    </section>
  )
}

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

  const setReserved = (next: Range[]): void => {
    setSaved(false)
    setDirty((d) => ({ ...d, reserved: next }))
  }

  const setLinkedVlan = (next: Range | null): void => {
    setSaved(false)
    setDirty((d) => ({ ...d, linkedVlanRange: next }))
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
      <LinkedVlanEditor value={current.linkedVlanRange as Range | null} onChange={setLinkedVlan} />
      <ReservedEditor ranges={current.reserved as Range[]} onChange={setReserved} />
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
