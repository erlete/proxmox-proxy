import { useEffect, useState, type ReactElement } from 'react'
import { api } from './api'
import { Keys } from './views/Keys'
import { Login } from './views/Login'
import { Operations } from './views/Operations'
import { Overview } from './views/Overview'
import { Queues } from './views/Queues'

type Auth = 'loading' | 'login' | 'ready'
type Page = 'overview' | 'queues' | 'operations' | 'keys'

const PAGES: { id: Page; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'queues', label: 'Queues' },
  { id: 'operations', label: 'Operations' },
  { id: 'keys', label: 'Keys' },
]

export function App(): ReactElement {
  const [auth, setAuth] = useState<Auth>('loading')
  const [page, setPage] = useState<Page>('overview')

  useEffect(() => {
    const onUnauthorized = (): void => setAuth('login')
    window.addEventListener('pp:unauthorized', onUnauthorized)
    void api.GET('/api/me').then(({ data }) => {
      setAuth(data?.username ? 'ready' : 'login')
    })
    return () => window.removeEventListener('pp:unauthorized', onUnauthorized)
  }, [])

  if (auth === 'loading') return <div className="boot">loading</div>
  if (auth === 'login') return <Login onSuccess={() => setAuth('ready')} />

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-dot" />
          proxmox-proxy
        </div>
        <nav>
          {PAGES.map((p) => (
            <button
              key={p.id}
              className={page === p.id ? 'nav-item active' : 'nav-item'}
              onClick={() => setPage(p.id)}
            >
              {p.label}
            </button>
          ))}
        </nav>
        <button
          className="nav-item logout"
          onClick={() => {
            void api.DELETE('/api/session').then(() => setAuth('login'))
          }}
        >
          Log out
        </button>
      </aside>
      <main className="content">
        {page === 'overview' && <Overview />}
        {page === 'queues' && <Queues />}
        {page === 'operations' && <Operations />}
        {page === 'keys' && <Keys />}
      </main>
    </div>
  )
}
