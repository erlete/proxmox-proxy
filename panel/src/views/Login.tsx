import { useState, type FormEvent, type ReactElement } from 'react'
import { Waypoints } from 'lucide-react'
import { api } from '../api'

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
      <form className="login-card" onSubmit={(e) => void submit(e)}>
        <div className="login-brand">
          <Waypoints size={40} strokeWidth={2} className="brand-icon" />
          <div>
            <div className="login-title">proxmox-proxy</div>
            <div className="muted">cluster control plane</div>
          </div>
        </div>
        <label>
          Username
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
        <button className="btn primary" disabled={busy || !username || !password}>
          {busy ? 'Signing in' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
