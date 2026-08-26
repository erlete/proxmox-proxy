import { useEffect, useRef, useState, type ReactElement } from 'react'
import {
  DatabaseBackup,
  Download,
  MonitorPlay,
  Network,
  Plus,
  ShieldBan,
  Upload,
  X,
} from 'lucide-react'
import { api } from '../api'
import type { paths } from '../api/schema'

type SettingsBody = paths['/api/settings']['get']['responses'][200]['content']['application/json']
type Values = SettingsBody['settings']
type Range = [number, number]

interface FieldDef {
  key: Exclude<
    keyof Values,
    'appPriority' | 'reserved' | 'linkedVlanRange' | 'streamProtect' | 'streamPacingMs'
  >
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
      {
        key: 'autoBackupIntervalHours',
        label: 'Auto backup every (h)',
        hint: 'rotating snapshot interval',
      },
      {
        key: 'autoBackupKeep',
        label: 'Auto backups kept',
        hint: 'snapshots retained in /data/backups; 0 disables',
      },
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
 * Stream guard: while a node has live consoles, heavy ops (clone, delete,
 * suspend) on it run one at a time with a minimum gap between starts. With no
 * console open, the caps above apply untouched.
 */
function StreamGuardEditor({
  enabled,
  pacingMs,
  pacingDefault,
  onToggle,
  onPacing,
}: {
  enabled: boolean
  pacingMs: number
  pacingDefault: number
  onToggle: (next: boolean) => void
  onPacing: (raw: string) => void
}): ReactElement {
  return (
    <section className="card settings-group">
      <div className="card-title">
        <MonitorPlay size={13} className="muted" /> Stream guard
      </div>
      <p className="hint settings-note">
        While a node has live consoles (running vncproxy tasks, watched in the same cluster poll as
        the out-of-band discount), heavy operations on it run one at a time with a minimum gap
        between starts, so a viewer never pays for a burst. With no console open, the caps above
        apply untouched. Applied hot on save.
      </p>
      <div className="settings-grid">
        <label>
          Guard enabled
          <span style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 30 }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => onToggle(e.target.checked)}
              style={{ width: 'auto' }}
            />
            <span className="hint">{enabled ? 'protecting live consoles' : 'off: caps only'}</span>
          </span>
        </label>
        <label>
          Pacing (ms)
          <input
            value={String(pacingMs)}
            onChange={(e) => onPacing(e.target.value)}
            inputMode="numeric"
            placeholder={String(pacingDefault)}
            disabled={!enabled}
          />
          <span className="hint">
            gap between heavy-op starts on a guarded node (default {pacingDefault})
          </span>
        </label>
      </div>
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

/**
 * Full backup and restore of the proxy's durable state (keys, settings,
 * operation history, VLAN leases, panel secrets) as one SQLite file. Restore
 * is a FULL OVERWRITE staged atomically and applied by a self-restart.
 */
function BackupCard(): ReactElement {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [tokenConfigured, setTokenConfigured] = useState(false)
  const [freshToken, setFreshToken] = useState<string | null>(null)

  useEffect(() => {
    void fetch('/api/backup-token')
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { configured: boolean } | null) => {
        if (b) setTokenConfigured(b.configured)
      })
  }, [])

  const generateToken = async (): Promise<void> => {
    const res = await fetch('/api/backup-token', { method: 'POST' })
    if (res.ok) {
      const body = (await res.json()) as { token: string }
      setFreshToken(body.token)
      setTokenConfigured(true)
    }
  }

  const disableToken = async (): Promise<void> => {
    if (!window.confirm('Disable the backup pull token? Any external cron using it stops working.'))
      return
    const res = await fetch('/api/backup-token', { method: 'DELETE' })
    if (res.ok || res.status === 204) {
      setTokenConfigured(false)
      setFreshToken(null)
    }
  }

  const restore = async (file: File): Promise<void> => {
    const ok = window.confirm(
      'FULL OVERWRITE: every app key, setting, operation record and VLAN lease ' +
        'will be replaced by the backup, and the proxy will restart. Continue?',
    )
    if (!ok) return
    setBusy(true)
    setErr(null)
    setMsg('Uploading backup...')
    try {
      const res = await fetch('/api/restore', {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null
        setErr(body?.message ?? `restore failed (${res.status})`)
        setMsg(null)
        setBusy(false)
        return
      }
      setMsg('Backup staged. The proxy is restarting; this page reloads when it is back.')
      // Wait for the restart, then reload (the session may need a fresh login:
      // the restored database brings its own panel secrets).
      await new Promise((r) => setTimeout(r, 3000))
      for (let i = 0; i < 30; i++) {
        try {
          const health = await fetch('/api/health')
          if (health.ok) break
        } catch {
          // still restarting
        }
        await new Promise((r) => setTimeout(r, 2000))
      }
      window.location.reload()
    } catch {
      setErr('upload failed; the proxy may be restarting already')
      setBusy(false)
    }
  }

  return (
    <section className="card settings-group">
      <div className="card-title">
        <DatabaseBackup size={13} className="muted" /> Backup and restore
      </div>
      <p className="hint settings-note">
        One SQLite file with the whole durable state: app keys (hashed), settings, operation
        history, VLAN leases and the panel secrets. Boot-level environment config (upstream, service
        token, console identity, bind) is not included; it travels with the compose deployment.
        Restore is a full overwrite applied atomically on a self-restart.
      </p>
      <div className="toolbar">
        <a className="btn icon-btn" href="/api/backup" download>
          <Download size={13} /> Download backup
        </a>
        <button className="btn icon-btn" disabled={busy} onClick={() => fileRef.current?.click()}>
          <Upload size={13} /> Restore from file
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".db,.sqlite,application/octet-stream"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (file) void restore(file)
          }}
        />
      </div>
      {msg && <span className="hint">{msg}</span>}
      {err && <div className="error">{err}</div>}
      <p className="hint settings-note" style={{ marginTop: 14 }}>
        Pull token: lets an external cron download the backup with a single header, no login flow.
        The off-host copy is the disaster-recovery leg; the rotating snapshots in /data/backups
        (General settings) only protect against corruption and operator error.
      </p>
      <div className="toolbar">
        <button className="btn small" onClick={() => void generateToken()}>
          {tokenConfigured ? 'Regenerate pull token' : 'Generate pull token'}
        </button>
        {tokenConfigured && (
          <button className="btn small" onClick={() => void disableToken()}>
            Disable
          </button>
        )}
        {tokenConfigured && !freshToken && <span className="badge ok">configured</span>}
      </div>
      {freshToken && (
        <div className="hint" style={{ marginTop: 8 }}>
          Shown once, store it now: <code className="mono">{freshToken}</code>
          <br />
          <code className="mono">
            {`curl -sf -H "X-Backup-Token: ${freshToken}" ${window.location.origin}/api/backup -o proxy-backup.db`}
          </code>
        </div>
      )}
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
      <StreamGuardEditor
        enabled={current.streamProtect}
        pacingMs={current.streamPacingMs}
        pacingDefault={defaults.streamPacingMs}
        onToggle={(next) => {
          setSaved(false)
          setDirty((d) => ({ ...d, streamProtect: next }))
        }}
        onPacing={(raw) => edit('streamPacingMs', raw)}
      />
      <LinkedVlanEditor value={current.linkedVlanRange as Range | null} onChange={setLinkedVlan} />
      <ReservedEditor ranges={current.reserved as Range[]} onChange={setReserved} />
      <BackupCard />
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
