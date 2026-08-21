import { useEffect, useState } from 'react'
import type { paths } from './api/schema'

export type QueuesSnapshot = paths['/api/queues']['get']['responses'][200]['content']['application/json']

/**
 * One shared EventSource for the whole panel: sidebar badge, overview meters
 * and the queues view all feed from the same live stream.
 */
let es: EventSource | null = null
let snapshot: QueuesSnapshot | null = null
let connected = false
const subs = new Set<() => void>()

const emit = (): void => {
  for (const s of subs) s()
}

function ensure(): void {
  if (es) return
  es = new EventSource('/api/events')
  es.addEventListener('queues', (e) => {
    snapshot = JSON.parse((e as MessageEvent).data) as QueuesSnapshot
    connected = true
    emit()
  })
  es.onopen = () => {
    connected = true
    emit()
  }
  es.onerror = () => {
    connected = false
    emit()
  }
}

export function useLive(enabled = true): { queues: QueuesSnapshot | null; connected: boolean } {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!enabled) return
    ensure()
    const f = (): void => tick((n) => n + 1)
    subs.add(f)
    return () => {
      subs.delete(f)
    }
  }, [enabled])
  return { queues: snapshot, connected }
}

export function busyCount(q: QueuesSnapshot | null): number {
  if (!q) return 0
  return q.classes.reduce((acc, c) => acc + c.running.length + c.waiting.length, 0)
}
