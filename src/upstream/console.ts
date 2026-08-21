import { UpstreamError, type Upstream } from './client.js'
import { log } from '../log.js'

export interface ConsoleCreds {
  username: string
  password: string
}

export interface ConsoleSession {
  /** VNC websocket port on the node, as returned by vncproxy. */
  port: string
  /** One-shot vncticket, bound to the console identity and the VM path. */
  ticket: string
  /** PVEAuthCookie value the app must send on the websocket upgrade. */
  cookie: string
  /** When the cookie stops being trustworthy (conservative bound). */
  expiresAt: number
}

export class ConsoleDisabledError extends Error {
  constructor() {
    super('console sessions are not configured on this proxy')
    this.name = 'ConsoleDisabledError'
  }
}

interface CachedAuth {
  ticket: string
  csrf: string
  mintedAt: number
}

/** Proxmox tickets live ~2h; re-mint well before that. */
const AUTH_TTL_MS = 90 * 60_000
const COOKIE_VALIDITY_MS = 115 * 60_000

/**
 * Mints VNC console credentials so apps never hold a Proxmox credential of
 * their own. Uses a DEDICATED low-privilege identity (VM.Console only):
 * Proxmox validates the vncticket against the authenticated websocket user,
 * so the vncproxy call and the websocket upgrade must share this identity.
 * The session cookie requires password auth (API tokens cannot mint tickets),
 * which is why this identity has a password while the service token does not.
 */
export class ConsoleBroker {
  private auth: CachedAuth | null = null
  private minting: Promise<CachedAuth> | null = null

  constructor(
    private upstream: Upstream,
    private creds: ConsoleCreds | null,
  ) {}

  get enabled(): boolean {
    return this.creds != null
  }

  private async mintAuth(): Promise<CachedAuth> {
    const body = new URLSearchParams({
      username: this.creds!.username,
      password: this.creds!.password,
    }).toString()
    const res = await this.upstream.pool.request({
      method: 'POST',
      path: '/api2/json/access/ticket',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      headersTimeout: 15_000,
    })
    const text = await res.body.text()
    if (res.statusCode >= 400) {
      throw new UpstreamError(`console auth failed (${res.statusCode})`, res.statusCode, text)
    }
    const data = (
      JSON.parse(text) as {
        data: { ticket: string; CSRFPreventionToken: string }
      }
    ).data
    this.auth = { ticket: data.ticket, csrf: data.CSRFPreventionToken, mintedAt: Date.now() }
    log.info('console identity ticket minted', { user: this.creds!.username })
    return this.auth
  }

  private ensureAuth(force = false): Promise<CachedAuth> {
    if (!force && this.auth && Date.now() - this.auth.mintedAt < AUTH_TTL_MS) {
      return Promise.resolve(this.auth)
    }
    // Single-flight: concurrent console opens must not stampede logins.
    if (!this.minting) {
      this.minting = this.mintAuth().finally(() => {
        this.minting = null
      })
    }
    return this.minting
  }

  async createSession(node: string, vmid: number): Promise<ConsoleSession> {
    if (!this.creds) throw new ConsoleDisabledError()

    let auth = await this.ensureAuth()
    const vncproxy = async (): Promise<{ statusCode: number; text: string }> => {
      const res = await this.upstream.pool.request({
        method: 'POST',
        path: `/api2/json/nodes/${encodeURIComponent(node)}/qemu/${vmid}/vncproxy`,
        headers: {
          cookie: `PVEAuthCookie=${auth.ticket}`,
          csrfpreventiontoken: auth.csrf,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: 'websocket=1',
        headersTimeout: 15_000,
      })
      return { statusCode: res.statusCode, text: await res.body.text() }
    }

    let res = await vncproxy()
    if (res.statusCode === 401) {
      // Cookie expired earlier than expected (cluster restart, clock drift).
      auth = await this.ensureAuth(true)
      res = await vncproxy()
    }
    if (res.statusCode >= 400) {
      throw new UpstreamError(`vncproxy failed (${res.statusCode})`, res.statusCode, res.text)
    }
    const data = (JSON.parse(res.text) as { data: { port: string | number; ticket: string } }).data
    return {
      port: String(data.port),
      ticket: data.ticket,
      cookie: auth.ticket,
      expiresAt: auth.mintedAt + COOKIE_VALIDITY_MS,
    }
  }
}
