import createClient from 'openapi-fetch'
import type { paths } from './api/schema'

/**
 * Typed client generated from the admin API's OpenAPI document.
 * If the API changes shape, the panel build breaks at compile time.
 */
export const api = createClient<paths>({ baseUrl: '/' })

export function notifyUnauthorized(): void {
  window.dispatchEvent(new Event('pp:unauthorized'))
}

api.use({
  onResponse({ response }) {
    if (response.status === 401) notifyUnauthorized()
    return undefined
  },
})

export function formatTs(ts: number | null | undefined): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString()
}

export function formatAgo(ts: number | null | undefined): string {
  if (!ts) return '-'
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

export function formatMs(ms: number | null | undefined): string {
  if (ms == null) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}
