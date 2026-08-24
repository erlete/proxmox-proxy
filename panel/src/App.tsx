import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react'
import {
  ArrowUpNarrowWide,
  Boxes,
  CircleStop,
  Gauge,
  History,
  KeyRound,
  Layers,
  LogOut,
  RefreshCw,
  Search,
  Server,
  ShieldBan,
  SlidersHorizontal,
  TriangleAlert,
} from 'lucide-react'
import { api } from './api'
import { busyCount, useLive } from './live'
import { Apps } from './views/Apps'
import { AppSummary } from './views/AppSummary'
import { BandOperations, BandSummary } from './views/Bands'
import { ClusterSummary } from './views/ClusterSummary'
import { Login } from './views/Login'
import { Operations } from './views/Operations'
import { Priorities } from './views/Priorities'
import { Queues } from './views/Queues'
import { Settings } from './views/Settings'
import type { paths } from './api/schema'

type Auth = 'loading' | 'login' | 'ready'
type AppRow =
  paths['/api/keys']['get']['responses'][200]['content']['application/json']['keys'][number]
type Inventory = paths['/api/inventory']['get']['responses'][200]['content']['application/json']

type NodeType = 'cluster' | 'app' | 'reserved' | 'unassigned'
type Tab = 'summary' | 'keys' | 'queues' | 'operations' | 'settings'

const TABS: Record<NodeType, Tab[]> = {
  cluster: ['summary', 'keys', 'queues', 'operations', 'settings'],
  app: ['summary', 'queues', 'operations'],
  reserved: ['summary', 'operations'],
  unassigned: ['summary', 'operations'],
}
const TAB_LABEL: Record<Tab, string> = {
  summary: 'Summary',
  keys: 'Apps & keys',
  queues: 'Queues',
  operations: 'Operations',
  settings: 'Settings',
}
const TAB_ICON: Record<Tab, typeof Gauge> = {
  summary: Gauge,
  keys: KeyRound,
  queues: Layers,
  operations: History,
  settings: SlidersHorizontal,
}

/** The gateway glyph mark (not the Proxmox logo). */
function Mark(): ReactElement {
  return (
    <span className="mark" aria-hidden="true">
      <svg
        width="15"
        height="15"
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

function StopTaskModal({ onClose }: { onClose: () => void }): ReactElement {
  const [upid, setUpid] = useState('')
  const [state, setState] = useState<'idle' | 'stopping' | 'done' | 'error'>('idle')
  const stop = async (): Promise<void> => {
    setState('stopping')
    const { error } = await api.POST('/api/tasks/stop', { body: { upid: upid.trim() } })
    setState(error ? 'error' : 'done')
  }
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Stop a running task</h2>
        <p>
          Paste the UPID of a Proxmox task to stop it. The admission slot it holds is freed as soon
          as the task ends.
        </p>
        <input
          className="stop-upid"
          value={upid}
          onChange={(e) => setUpid(e.target.value)}
          placeholder="UPID:node:..."
          autoFocus
        />
        {state === 'done' && (
          <div className="badge ok" style={{ marginTop: 10 }}>
            task stopped
          </div>
        )}
        {state === 'error' && <div className="error">could not stop that task</div>}
        <div className="modal-actions">
          <button
            className="btn danger-solid icon-btn"
            disabled={!upid.trim() || state === 'stopping'}
            onClick={() => void stop()}
          >
            <CircleStop size={14} /> Stop task
          </button>
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

export function App(): ReactElement {
  const [auth, setAuth] = useState<Auth>('loading')
  const [node, setNode] = useState<string>('cluster')
  const [tab, setTab] = useState<Tab>('summary')
  const [refreshKey, setRefreshKey] = useState(0)
  const [apps, setApps] = useState<AppRow[]>([])
  const [inv, setInv] = useState<Inventory | null>(null)
  const [stopOpen, setStopOpen] = useState(false)
  const { queues } = useLive(auth === 'ready')
  const busy = busyCount(queues)
  const gridRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onUnauthorized = (): void => setAuth('login')
    window.addEventListener('pp:unauthorized', onUnauthorized)
    void api.GET('/api/me').then(({ data }) => setAuth(data?.username ? 'ready' : 'login'))
    return () => window.removeEventListener('pp:unauthorized', onUnauthorized)
  }, [])

  const loadTree = useCallback(async (): Promise<void> => {
    const [k, i] = await Promise.all([api.GET('/api/keys'), api.GET('/api/inventory')])
    if (k.data) setApps(k.data.keys)
    if (i.data) setInv(i.data)
  }, [])

  useEffect(() => {
    if (auth === 'ready') void loadTree()
  }, [auth, loadTree, refreshKey])

  const refresh = (): void => setRefreshKey((n) => n + 1)

  const nodeType = (key: string): NodeType =>
    key === 'cluster'
      ? 'cluster'
      : key === 'reserved'
        ? 'reserved'
        : key === 'unassigned'
          ? 'unassigned'
          : 'app'

  const select = (key: string): void => {
    const type = nodeType(key)
    setNode(key)
    if (!TABS[type].includes(tab)) setTab('summary')
  }

  // resizable side columns
  const startResize =
    (varName: string, min: number, max: number) =>
    (e: ReactPointerEvent<HTMLDivElement>): void => {
      e.preventDefault()
      const handle = e.currentTarget
      handle.classList.add('drag')
      handle.setPointerCapture(e.pointerId)
      const prev = handle.previousElementSibling?.getBoundingClientRect().width ?? 0
      const startX = e.clientX
      const move = (ev: PointerEvent): void => {
        const w = Math.max(min, Math.min(max, prev + (ev.clientX - startX)))
        gridRef.current?.style.setProperty(varName, `${w}px`)
      }
      const up = (): void => {
        handle.classList.remove('drag')
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    }

  if (auth === 'loading') return <div className="boot">loading</div>
  if (auth === 'login') return <Login onSuccess={() => setAuth('ready')} />

  const enabledApps = apps.filter((a) => a.enabled)
  const reservedCount = inv?.reserved.length ?? 0
  const unassignedCount = inv?.unassigned.length ?? 0
  const type = nodeType(node)
  const tabs = TABS[type]

  const content = ((): ReactElement => {
    if (type === 'cluster') {
      if (tab === 'keys') return <Apps />
      if (tab === 'queues') return <Queues />
      if (tab === 'operations') return <Operations />
      if (tab === 'settings')
        return (
          <>
            <Settings />
            <Priorities />
          </>
        )
      return <ClusterSummary />
    }
    if (type === 'app') {
      if (tab === 'queues') return <Queues filterKey={node} />
      if (tab === 'operations') return <Operations initialKey={node} lockKey />
      return <AppSummary name={node} />
    }
    // reserved / unassigned
    if (tab === 'operations') return <BandOperations kind={type} />
    return <BandSummary kind={type} />
  })()

  return (
    <div className="shell">
      <div className="topbar">
        <div className="brand">
          <Mark />
          <span className="name">
            proxmox<b>-proxy</b>
          </span>
        </div>
        <div className="search">
          <Search size={14} />
          <input placeholder="Search keys, VMIDs, operations…" aria-label="Search" />
        </div>
        <div className="top-actions">
          <button className="tbtn" onClick={refresh}>
            <RefreshCw size={14} /> Refresh
          </button>
          <button className="tbtn danger" onClick={() => setStopOpen(true)}>
            <CircleStop size={14} /> Stop task
          </button>
          <button
            className="tbtn"
            title="Log out"
            onClick={() => void api.DELETE('/api/session').then(() => setAuth('login'))}
          >
            <LogOut size={14} />
          </button>
        </div>
      </div>

      <div className="body" ref={gridRef}>
        <div className="col tree">
          <div
            className={node === 'cluster' ? 'node sel' : 'node'}
            onClick={() => select('cluster')}
          >
            <span className="ico">
              <Server size={14} />
            </span>
            <span className="lbl">liga</span>
          </div>
          {enabledApps.map((a) => (
            <div
              key={a.name}
              className={node === a.name ? 'node child sel' : 'node child'}
              onClick={() => select(a.name)}
            >
              <span className="dot ok" />
              <span className="ico">
                <Boxes size={13} />
              </span>
              <span className="lbl">{a.name}</span>
              <span className="meta">{a.vmidRanges[0]?.[0]}</span>
            </div>
          ))}
          {reservedCount > 0 && (
            <div
              className={node === 'reserved' ? 'node child sel' : 'node child'}
              onClick={() => select('reserved')}
            >
              <span className="dot res" />
              <span className="ico">
                <ShieldBan size={13} />
              </span>
              <span className="lbl">Reserved</span>
              <span className="meta">{reservedCount}</span>
            </div>
          )}
          {unassignedCount > 0 && (
            <div
              className={node === 'unassigned' ? 'node child sel' : 'node child'}
              onClick={() => select('unassigned')}
            >
              <span className="dot warn" />
              <span className="ico" style={{ color: 'var(--warn)' }}>
                <TriangleAlert size={13} />
              </span>
              <span className="lbl">Unassigned</span>
              <span className="meta">{unassignedCount}</span>
            </div>
          )}
        </div>

        <div className="rz" onPointerDown={startResize('--c1', 188, 440)} />

        <div className="col submenu">
          {tabs.map((t) => {
            const Icon = TAB_ICON[t]
            return (
              <div key={t} className={tab === t ? 'mitem sel' : 'mitem'} onClick={() => setTab(t)}>
                <Icon size={15} />
                <span>{TAB_LABEL[t]}</span>
                {type === 'cluster' && t === 'queues' && busy > 0 && (
                  <span className="badge warn nav-badge">{busy}</span>
                )}
              </div>
            )
          })}
        </div>

        <div className="rz" onPointerDown={startResize('--c2', 150, 320)} />

        <div className="col content enter" key={`${node}:${tab}:${refreshKey}`}>
          {content}
        </div>
      </div>

      {stopOpen && <StopTaskModal onClose={() => setStopOpen(false)} />}
    </div>
  )
}
