import { log } from '../log.js'
import type { Upstream } from './client.js'

export interface HealthState {
  ok: boolean
  version: string | null
  checkedAt: number
  error: string | null
}

export class HealthMonitor {
  state: HealthState = { ok: false, version: null, checkedAt: 0, error: null }
  private timer: NodeJS.Timeout | null = null

  constructor(
    private upstream: Upstream,
    private intervalMs = 30_000,
  ) {}

  start(): void {
    void this.check()
    this.timer = setInterval(() => void this.check(), this.intervalMs)
    this.timer.unref()
  }

  async check(): Promise<void> {
    const wasOk = this.state.ok
    try {
      const data = await this.upstream.api<{ version: string }>('GET', '/version')
      this.state = { ok: true, version: data.version, checkedAt: Date.now(), error: null }
      if (!wasOk) log.info('upstream reachable', { version: data.version })
    } catch (err) {
      this.state = { ok: false, version: null, checkedAt: Date.now(), error: String(err) }
      if (wasOk) log.warn('upstream unreachable', { error: String(err) })
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }
}
