import { readFileSync } from 'node:fs'
import type { Readable } from 'node:stream'
import { Pool, type Dispatcher } from 'undici'

export interface UpstreamOpts {
  url: URL
  caPath: string | null
  insecure: boolean
  serviceToken: string
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly body?: string,
  ) {
    super(message)
    this.name = 'UpstreamError'
  }
}

/**
 * Connection pool to pveproxy. `raw` is the data-plane passthrough;
 * `api` is for the proxy's own control calls (singleton lock, task polling,
 * health), always authenticated with the service token.
 */
export class Upstream {
  readonly pool: Pool
  readonly origin: string
  private readonly authHeader: string

  constructor(opts: UpstreamOpts) {
    this.origin = opts.url.origin
    this.authHeader = `PVEAPIToken=${opts.serviceToken}`
    this.pool = new Pool(this.origin, {
      connections: 8,
      connect: {
        ca: opts.caPath ? readFileSync(opts.caPath) : undefined,
        rejectUnauthorized: !opts.insecure,
      },
    })
  }

  raw(opts: {
    method: Dispatcher.HttpMethod
    path: string
    headers: Record<string, string | string[]>
    body?: Buffer | Readable
  }): Promise<Dispatcher.ResponseData> {
    return this.pool.request({
      method: opts.method,
      path: opts.path,
      headers: opts.headers,
      body: opts.body,
      headersTimeout: 60_000,
      bodyTimeout: 0,
    })
  }

  async api<T = unknown>(
    method: Dispatcher.HttpMethod,
    path: string,
    body?: Record<string, string | number>,
  ): Promise<T> {
    const headers: Record<string, string> = { authorization: this.authHeader }
    let bodyStr: string | undefined
    if (body) {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      const params = new URLSearchParams()
      for (const [k, v] of Object.entries(body)) params.append(k, String(v))
      bodyStr = params.toString()
    }
    const res = await this.pool.request({
      method,
      path: `/api2/json${path}`,
      headers,
      body: bodyStr,
      headersTimeout: 30_000,
    })
    const text = await res.body.text()
    if (res.statusCode >= 400) {
      throw new UpstreamError(
        `upstream ${method} ${path} -> ${res.statusCode}`,
        res.statusCode,
        text,
      )
    }
    try {
      return (JSON.parse(text) as { data: T }).data
    } catch {
      throw new UpstreamError(`upstream ${method} ${path}: invalid JSON body`, res.statusCode, text)
    }
  }

  close(): Promise<void> {
    return this.pool.close()
  }
}
