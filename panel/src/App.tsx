import { useEffect, useState, type ReactElement } from 'react'
import { Boxes, Gauge, History, Layers, LogOut, SlidersHorizontal, Waypoints } from 'lucide-react'
import { api } from './api'
import { busyCount, useLive } from './live'
import { Apps } from './views/Apps'
import { Login } from './views/Login'
import { Operations } from './views/Operations'
import { Overview } from './views/Overview'
import { Queues } from './views/Queues'
import { Settings } from './views/Settings'

type Auth = 'loading' | 'login' | 'ready'

const PAGES = [
  { id: 'overview', label: 'Overview', icon: Gauge },
  { id: 'queues', label: 'Queues', icon: Layers },
  { id: 'operations', label: 'Operations', icon: History },
  { id: 'apps', label: 'Apps', icon: Boxes },
  { id: 'settings', label: 'Settings', icon: SlidersHorizontal },
] as const

type Page = (typeof PAGES)[number]['id']

export function App(): ReactElement {
  const [auth, setAuth] = useState<Auth>('loading')
  const [page, setPage] = useState<Page>('overview')
  const { queues, connected } = useLive(auth === 'ready')
  const busy = busyCount(queues)

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
          <Waypoints className="brand-icon" size={22} strokeWidth={2.2} />
          <span>proxmox-proxy</span>
        </div>
        <nav>
          {PAGES.map((p) => (
            <button
              key={p.id}
              className={page === p.id ? 'nav-item active' : 'nav-item'}
              onClick={() => setPage(p.id)}
            >
              <p.icon size={16} />
              <span>{p.label}</span>
              {p.id === 'queues' && busy > 0 && <span className="nav-badge">{busy}</span>}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <div className="side-status">
            <span className={connected ? 'live-dot on' : 'live-dot'} />
            {connected ? 'live' : 'reconnecting'}
          </div>
          <button
            className="nav-item logout"
            onClick={() => {
              void api.DELETE('/api/session').then(() => setAuth('login'))
            }}
          >
            <LogOut size={16} />
            <span>Log out</span>
          </button>
        </div>
      </aside>
      <main className="content">
        {page === 'overview' && <Overview />}
        {page === 'queues' && <Queues />}
        {page === 'operations' && <Operations />}
        {page === 'apps' && <Apps />}
        {page === 'settings' && <Settings />}
      </main>
    </div>
  )
}
