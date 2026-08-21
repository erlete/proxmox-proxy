import { hostname } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { log } from '../log.js'
import { Upstream, UpstreamError } from './client.js'

interface Marker {
  i: string
  h: string
  t: number
}

export class SingletonHeldError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SingletonHeldError'
  }
}

export interface SingletonOpts {
  poolId: string
  instanceId: string
  heartbeatMs: number
  staleMs: number
  /** Called when another instance takes the lock over: this one must stop. */
  onLost: () => void
}

/**
 * Cluster-wide mutual exclusion: only one proxy may guard a cluster. The
 * ground truth lives in the cluster itself (the comment of a reserved pool)
 * because it is the only thing rival proxies share. A fresh marker from
 * another instance means refuse to start; a stale one means take over.
 */
export class SingletonLock {
  private timer: NodeJS.Timeout | null = null
  private consecutiveFailures = 0
  held = false

  constructor(
    private upstream: Upstream,
    private opts: SingletonOpts,
  ) {}

  private marker(t = Date.now()): string {
    return JSON.stringify({ i: this.opts.instanceId, h: hostname(), t } satisfies Marker)
  }

  private parse(comment: string): Marker | null {
    try {
      const m = JSON.parse(comment) as Marker
      if (typeof m.i !== 'string' || typeof m.t !== 'number') return null
      return m
    } catch {
      return null
    }
  }

  private async readMarker(): Promise<Marker | null | 'missing'> {
    try {
      const data = await this.upstream.api<{ comment?: string }>(
        'GET',
        `/pools/${this.opts.poolId}`,
      )
      return data?.comment ? this.parse(data.comment) : null
    } catch (err) {
      // Proxmox answers a missing pool with an error status; treat any
      // 4xx/5xx here as "not there yet" and let the create/claim path decide.
      if (err instanceof UpstreamError) return 'missing'
      throw err
    }
  }

  private writeMarker(t?: number): Promise<unknown> {
    return this.upstream.api('PUT', `/pools/${this.opts.poolId}`, { comment: this.marker(t) })
  }

  async acquire(): Promise<void> {
    const existing = await this.readMarker()
    if (existing === 'missing') {
      await this.upstream.api('POST', '/pools', {
        poolid: this.opts.poolId,
        comment: this.marker(),
      })
    } else {
      if (
        existing &&
        existing.i !== this.opts.instanceId &&
        Date.now() - existing.t < this.opts.staleMs
      ) {
        throw new SingletonHeldError(
          `another proxy already guards this cluster (host ${existing.h}, instance ${existing.i}, ` +
            `heartbeat ${new Date(existing.t).toISOString()})`,
        )
      }
      await this.writeMarker()
    }

    // Confirm we won any simultaneous-claim race before declaring ourselves up.
    await sleep(750)
    const check = await this.readMarker()
    if (check === 'missing' || !check || check.i !== this.opts.instanceId) {
      throw new SingletonHeldError('lost the cluster lock race to another starting instance')
    }

    this.held = true
    this.timer = setInterval(() => void this.heartbeat(), this.opts.heartbeatMs)
    this.timer.unref()
    log.info('cluster singleton lock acquired', { pool: this.opts.poolId })
  }

  private async heartbeat(): Promise<void> {
    try {
      const current = await this.readMarker()
      if (current !== 'missing' && current && current.i !== this.opts.instanceId) {
        // Only a rival writes a different instance id: we were considered
        // stale and replaced. Split brain is worse than stopping, so stop.
        this.held = false
        log.error('cluster lock taken over by another instance, shutting down', {
          holder: current.i,
          host: current.h,
        })
        this.opts.onLost()
        return
      }
      await this.writeMarker()
      this.consecutiveFailures = 0
    } catch (err) {
      // Upstream outages must not kill the proxy: keep serving, keep trying.
      this.consecutiveFailures += 1
      if (this.consecutiveFailures <= 3 || this.consecutiveFailures % 10 === 0) {
        log.warn('singleton heartbeat failed', {
          failures: this.consecutiveFailures,
          error: String(err),
        })
      }
    }
  }

  /** Mark the lock stale (t=0) so a successor can take over instantly. */
  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    if (!this.held) return
    this.held = false
    try {
      await this.writeMarker(0)
      log.info('cluster singleton lock released')
    } catch (err) {
      log.warn('failed to release cluster lock (will expire as stale)', { error: String(err) })
    }
  }
}
