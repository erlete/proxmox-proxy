import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from 'react'
import { api, formatAgo, formatTs } from '../api'
import type { paths } from '../api/schema'

type KeyList = paths['/api/keys']['get']['responses'][200]['content']['application/json']
type KeyRow = KeyList['keys'][number]

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

function TokenModal({ token, onClose }: { token: string; onClose: () => void }): ReactElement {
  const [copied, setCopied] = useState(false)
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>API key issued</h2>
        <p>
          Copy it now: the secret is stored hashed and <strong>cannot be shown again</strong>.
        </p>
        <code className="token">{token}</code>
        <div className="modal-actions">
          <button
            className="btn primary"
            onClick={() => {
              void navigator.clipboard.writeText(token).then(() => setCopied(true))
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

export function Keys(): ReactElement {
  const [keys, setKeys] = useState<KeyRow[]>([])
  const [name, setName] = useState('')
  const [rangesText, setRangesText] = useState('')
  const [comment, setComment] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [token, setToken] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const { data } = await api.GET('/api/keys')
    if (data) setKeys(data.keys)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const create = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setError(null)
    const vmidRanges = parseRanges(rangesText)
    if (!vmidRanges) {
      setError('Ranges must look like: 1100100-1100999, 2200100-2200999 (min 100)')
      return
    }
    const { data, error: apiError } = await api.POST('/api/keys', {
      body: { name, vmidRanges, ...(comment ? { comment } : {}) },
    })
    if (data) {
      setToken(data.token)
      setName('')
      setRangesText('')
      setComment('')
      void load()
    } else {
      setError((apiError as { message?: string } | undefined)?.message ?? 'creation failed')
    }
  }

  const rotate = async (keyName: string): Promise<void> => {
    const input = window.prompt(`Rotate "${keyName}": grace hours for the old secret`, '24')
    if (input == null) return
    const graceHours = Number.parseFloat(input)
    if (!Number.isFinite(graceHours) || graceHours < 0) return
    const { data } = await api.POST('/api/keys/{name}/rotate', {
      params: { path: { name: keyName } },
      body: { graceHours },
    })
    if (data) {
      setToken(data.token)
      void load()
    }
  }

  const revoke = async (keyName: string): Promise<void> => {
    if (!window.confirm(`Revoke "${keyName}"? The app using it loses access permanently.`)) return
    await api.DELETE('/api/keys/{name}', { params: { path: { name: keyName } } })
    void load()
  }

  return (
    <div>
      <h1>Keys</h1>
      <form className="card key-form" onSubmit={(e) => void create(e)}>
        <div className="key-form-row">
          <label>
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="app-name"
              pattern="[a-z0-9][a-z0-9-]+"
            />
          </label>
          <label className="grow">
            VMID ranges
            <input
              value={rangesText}
              onChange={(e) => setRangesText(e.target.value)}
              placeholder="1100100-1100999, 2200100-2200999"
            />
          </label>
          <label className="grow">
            Comment
            <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="optional" />
          </label>
          <button className="btn primary" disabled={!name || !rangesText}>
            Create key
          </button>
        </div>
        {error && <div className="error">{error}</div>}
      </form>

      {keys.length === 0 ? (
        <div className="empty">no keys yet</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>name</th>
              <th>ranges</th>
              <th>state</th>
              <th>created</th>
              <th>rotated</th>
              <th>last used</th>
              <th>comment</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.name} className={k.enabled ? '' : 'dim'}>
                <td className="mono">{k.name}</td>
                <td className="mono">{k.vmidRanges.map(([a, b]) => `${a}-${b}`).join(', ')}</td>
                <td>
                  {k.enabled ? (
                    k.prevValidUntil && k.prevValidUntil > Date.now() ? (
                      <span className="badge warn" title={`old secret valid until ${formatTs(k.prevValidUntil)}`}>
                        rotating
                      </span>
                    ) : (
                      <span className="badge ok">active</span>
                    )
                  ) : (
                    <span className="badge err">revoked</span>
                  )}
                </td>
                <td className="nowrap">{formatTs(k.createdAt)}</td>
                <td className="nowrap">{k.rotatedAt ? formatTs(k.rotatedAt) : '-'}</td>
                <td>{k.lastUsedAt ? `${formatAgo(k.lastUsedAt)} ago` : 'never'}</td>
                <td className="muted">{k.comment || '-'}</td>
                <td className="nowrap">
                  {k.enabled && (
                    <>
                      <button className="btn small" onClick={() => void rotate(k.name)}>
                        Rotate
                      </button>{' '}
                      <button className="btn small danger" onClick={() => void revoke(k.name)}>
                        Revoke
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {token && <TokenModal token={token} onClose={() => setToken(null)} />}
    </div>
  )
}
