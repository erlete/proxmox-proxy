import { useState, type FormEvent, type ReactElement } from 'react'
import { api } from '../api'

/** The gateway glyph used as the proxmox-proxy mark (not the Proxmox logo). */
function Mark(): ReactElement {
  return (
    <span className="mark" aria-hidden="true">
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="#fff"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 8h13l-3-3M21 16H8l3 3" />
      </svg>
    </span>
  )
}

export function Login({ onSuccess }: { onSuccess: () => void }): ReactElement {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { response } = await api.POST('/api/session', { body: { username, password } })
    setBusy(false)
    if (response.ok) onSuccess()
    else if (response.status === 429) setError('Too many attempts, wait a few minutes')
    else setError('Invalid credentials')
  }

  return (
    <div className="login-wrap">
      <div className="login-brand-top">
        <Mark />
        <span className="name">
          proxmox<b>-proxy</b>
        </span>
      </div>
      <form className="login-card" onSubmit={(e) => void submit(e)}>
        <label>
          User
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error && <div className="error">{error}</div>}
        <div className="login-actions">
          <button className="btn primary" disabled={busy || !username || !password}>
            {busy ? 'Signing in' : 'Login'}
          </button>
        </div>
      </form>
    </div>
  )
}
