import { useCallback, useEffect, useState, type FormEvent, type ReactElement, type ReactNode } from 'react'
import { Ban, Boxes, Check, Copy, Plus, RotateCw } from 'lucide-react'
import { api, formatAgo, formatTs } from '../api'
import type { paths } from '../api/schema'

type KeyList = paths['/api/keys']['get']['responses'][200]['content']['application/json']
type AppRow = KeyList['keys'][number]
type OpRows = paths['/api/operations']['get']['responses'][200]['content']['application/json']['rows']

function parseRanges(text: string): [number, number][] | null {
  const parts = text
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length === 0) return null
  const ranges: [number, number][] = []
  for (const part of parts) {
    const m = /^(\d+)\s*-\s*(\d+)$/.exec(part)
    if (!m) return null
    const min = Number.parseInt(m[1], 10)
    const max = Number.parseInt(m[2], 10)
    if (min < 100 || max < min) return null
    ranges.push([min, max])
  }
  return ranges
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }): ReactElement {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  )
}

/** Shown exactly once: the app's ready-to-paste connection config. */
function ConnectionModal({ name, token, onClose }: { name: string; token: string; onClose: () => void }): ReactElement {
  const [copied, setCopied] = useState(false)
  const envBlock = `PROXMOX_PROXY_ENDPOINT=${window.location.origin}\nPROXMOX_PROXY_KEY=${token}`
  return (
    <Modal title={`Connection config for "${name}"`} onClose={onClose}>
      <p>
        Paste this into the app. The secret is stored hashed and <strong>cannot be shown again</strong>.
      </p>
      <code className="token">{envBlock}</code>
      <div className="modal-actions">
        <button
          className="btn primary icon-btn"
          onClick={() => {
            void navigator.clipboard.writeText(envBlock).then(() => setCopied(true))
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy config'}
        </button>
        <button className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  )
}

function CreateModal({ onDone, onClose }: { onDone: (name: string, token: string) => void; onClose: () => void }): ReactElement {
  const [name, setName] = useState('')
  const [rangesText, setRangesText] = useState('')
  const [comment, setComment] = useState('')
  const [error, setError] = useState<string | null>(null)

  const create = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setError(null)
    const vmidRanges = parseRanges(rangesText)
    if (!vmidRanges) {
      setError('Ranges must look like: 1100000-1100999, 2200100-2200999 (min 100)')
      return
    }
    const { data, error: apiError } = await api.POST('/api/keys', {
      body: { name, vmidRanges, ...(comment ? { comment } : {}) },
    })
    if (data) onDone(data.name, data.token)
    else setError((apiError as { message?: string } | undefined)?.message ?? 'creation failed')
  }

  return (
    <Modal title="Connect a new app" onClose={onClose}>
      <form className="modal-form" onSubmit={(e) => void create(e)}>
        <label>
          App name
          <input
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase())}
            placeholder="my-platform"
            pattern="[a-z0-9][a-z0-9-]+"
            autoFocus
          />
          <span className="hint">lowercase, digits and dashes; it becomes the key identity</span>
        </label>
        <label>
          VMID ranges the app may touch
          <input
            value={rangesText}
            onChange={(e) => setRangesText(e.target.value)}
            placeholder="1100000-1100999"
          />
          <span className="hint">comma-separated min-max; everything outside is denied</span>
        </label>
        <label>
          Comment
          <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="optional" />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button className="btn primary icon-btn" disabled={!name || !rangesText}>
            <Plus size={14} />
            Create and issue key
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  )
}

function RotateModal({ name, onDone, onClose }: { name: string; onDone: (token: string) => void; onClose: () => void }): ReactElement {
  const [grace, setGrace] = useState('24')
  const [error, setError] = useState<string | null>(null)

  const rotate = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    const graceHours = Number.parseFloat(grace)
    if (!Number.isFinite(graceHours) || graceHours < 0 || graceHours > 168) {
      setError('Grace must be between 0 and 168 hours')
      return
    }
    const { data } = await api.POST('/api/keys/{name}/rotate', {
      params: { path: { name } },
      body: { graceHours },
    })
    if (data) onDone(data.token)
    else setError('rotation failed')
  }

  return (
    <Modal title={`Rotate "${name}"`} onClose={onClose}>
      <form className="modal-form" onSubmit={(e) => void rotate(e)}>
        <p className="muted">
          A new secret is issued. The current one keeps working during the grace window so you can
          migrate the app without downtime.
        </p>
        <label>
          Grace window (hours)
          <input value={grace} onChange={(e) => setGrace(e.target.value)} inputMode="numeric" />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="modal-actions">
          <button className="btn primary icon-btn">
            <RotateCw size={14} />
            Rotate
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  )
}

function RevokeModal({ name, onDone, onClose }: { name: string; onDone: () => void; onClose: () => void }): ReactElement {
  return (
    <Modal title={`Revoke "${name}"`} onClose={onClose}>
      <p>
        The app loses access <strong>permanently</strong> and the name stays reserved. This cannot
        be undone.
      </p>
      <div className="modal-actions">
        <button
          className="btn danger-solid icon-btn"
          onClick={() => {
            void api.DELETE('/api/keys/{name}', { params: { path: { name } } }).then(onDone)
          }}
        >
          <Ban size={14} />
          Revoke access
        </button>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  )
}

export function Apps(): ReactElement {
  const [apps, setApps] = useState<AppRow[]>([])
  const [ops, setOps] = useState<OpRows>([])
  const [modal, setModal] = useState<
    | { kind: 'create' }
    | { kind: 'connection'; name: string; token: string }
    | { kind: 'rotate'; name: string }
    | { kind: 'revoke'; name: string }
    | null
  >(null)

  const load = useCallback(async (): Promise<void> => {
    const [keysRes, opsRes] = await Promise.all([
      api.GET('/api/keys'),
      api.GET('/api/operations', { params: { query: { limit: 1000 } } }),
    ])
    if (keysRes.data) setApps(keysRes.data.keys)
    if (opsRes.data) setOps(opsRes.data.rows)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const opCount = (name: string): number => ops.filter((o) => o.keyName === name).length

  const stateBadge = (app: AppRow): ReactElement => {
    if (!app.enabled) return <span className="badge err">revoked</span>
    if (app.prevValidUntil && app.prevValidUntil > Date.now())
      return (
        <span className="badge warn" title={`old secret valid until ${formatTs(app.prevValidUntil)}`}>
          rotating
        </span>
      )
    return <span className="badge ok">active</span>
  }

  return (
    <div>
      <div className="page-head">
        <h1>Apps</h1>
        <button className="btn primary icon-btn" onClick={() => setModal({ kind: 'create' })}>
          <Plus size={15} />
          Connect app
        </button>
      </div>
      <p className="muted settings-note">
        Every app connects with its own key (standard Proxmox token format) scoped to its VMID
        ranges. Creating an app issues its connection config.
      </p>

      {apps.length === 0 ? (
        <div className="empty card">
          <Boxes size={28} className="muted" />
          <div>
            <div className="strong">No apps connected yet</div>
            <div className="muted">Connect the first one to issue its key and ranges.</div>
          </div>
        </div>
      ) : (
        <div className="app-grid">
          {apps.map((app) => (
            <div className={app.enabled ? 'card app-card' : 'card app-card dim'} key={app.name}>
              <div className="card-head">
                <div className="app-name">
                  <Boxes size={16} className="card-icon" />
                  <span className="strong">{app.name}</span>
                </div>
                {stateBadge(app)}
              </div>
              <div className="chip-row">
                {app.vmidRanges.map(([a, b]) => (
                  <span className="chip mono" key={`${a}-${b}`}>
                    {a} - {b}
                  </span>
                ))}
              </div>
              <div className="app-meta">
                <span title={app.lastUsedAt ? formatTs(app.lastUsedAt) : ''}>
                  {app.lastUsedAt ? `active ${formatAgo(app.lastUsedAt)} ago` : 'never seen'}
                </span>
                <span>{opCount(app.name)} recent ops</span>
                <span title={formatTs(app.createdAt)}>since {formatTs(app.createdAt).split(',')[0]}</span>
              </div>
              {app.comment && <div className="muted app-comment">{app.comment}</div>}
              {app.enabled && (
                <div className="app-actions">
                  <button className="btn small icon-btn" onClick={() => setModal({ kind: 'rotate', name: app.name })}>
                    <RotateCw size={12} />
                    Rotate
                  </button>
                  <button
                    className="btn small danger icon-btn"
                    onClick={() => setModal({ kind: 'revoke', name: app.name })}
                  >
                    <Ban size={12} />
                    Revoke
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {modal?.kind === 'create' && (
        <CreateModal
          onClose={() => setModal(null)}
          onDone={(name, token) => {
            setModal({ kind: 'connection', name, token })
            void load()
          }}
        />
      )}
      {modal?.kind === 'connection' && (
        <ConnectionModal name={modal.name} token={modal.token} onClose={() => setModal(null)} />
      )}
      {modal?.kind === 'rotate' && (
        <RotateModal
          name={modal.name}
          onClose={() => setModal(null)}
          onDone={(token) => {
            setModal({ kind: 'connection', name: modal.name, token })
            void load()
          }}
        />
      )}
      {modal?.kind === 'revoke' && (
        <RevokeModal
          name={modal.name}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null)
            void load()
          }}
        />
      )}
    </div>
  )
}
