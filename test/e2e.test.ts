import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import { createApp, type App } from '../src/app.js'
import { loadConfig } from '../src/config.js'

/**
 * Boots the full proxy against a fake pveproxy and exercises the whole v0
 * contract: key auth, scoping, passthrough, admission and task tracking.
 */

let fake: Server
let fakePort = 0
let app: App
let dataUrl = ''
let adminUrl = ''
let cookie = ''
let appToken = ''

const stoppedTasks = new Set<string>()
let cloneCount = 0
let poolComment: string | null = null

function fakeUpstream(): Server {
  return createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake')
      const p = url.pathname
      const json = (status: number, data: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data }))
      }

      if (p === '/api2/json/version') return json(200, { version: '8.4.1' })

      // Backstop poll: no out-of-band cluster load in this fixture.
      if (p === '/api2/json/cluster/tasks') return json(200, [])

      // Cluster inventory: one VM inside app-a's range, one outside it.
      if (p === '/api2/json/cluster/resources') {
        return json(200, [
          { vmid: 1100100, node: 'n1', name: 'app-vm', status: 'running', type: 'qemu' },
          { vmid: 4242, node: 'n1', name: 'stray-vm', status: 'stopped', type: 'qemu' },
        ])
      }

      // Red button: stopping a running task (DELETE, no /status suffix).
      const delTask = /^\/api2\/json\/nodes\/n1\/tasks\/([^/]+)$/.exec(p)
      if (delTask && req.method === 'DELETE') {
        stoppedTasks.add(decodeURIComponent(delTask[1]))
        return json(200, `UPID:n1:0:0:0:stop:0:root@pam:`)
      }

      if (p === '/api2/json/access/ticket' && req.method === 'POST') {
        const params = new URLSearchParams(Buffer.concat(chunks).toString())
        if (
          params.get('username') !== 'svc-console@pve' ||
          params.get('password') !== 'console-pw'
        ) {
          return json(401, null)
        }
        return json(200, { ticket: 'FAKE-AUTH-COOKIE', CSRFPreventionToken: 'FAKE-CSRF' })
      }

      const vnc = /^\/api2\/json\/nodes\/n1\/qemu\/(\d+)\/vncproxy$/.exec(p)
      if (vnc && req.method === 'POST') {
        // The console identity authenticates with cookie + CSRF, never a token.
        if (req.headers.cookie !== 'PVEAuthCookie=FAKE-AUTH-COOKIE') return json(401, null)
        if (req.headers.csrfpreventiontoken !== 'FAKE-CSRF') return json(401, null)
        return json(200, { port: 5901, ticket: `VNCTICKET-${vnc[1]}` })
      }

      if (p === '/api2/json/pools/testlock' && req.method === 'GET') {
        if (poolComment == null) return json(500, null)
        return json(200, { comment: poolComment, members: [] })
      }
      if (p === '/api2/json/pools' && req.method === 'POST') {
        poolComment = new URLSearchParams(Buffer.concat(chunks).toString()).get('comment')
        return json(200, null)
      }
      if (p === '/api2/json/pools/testlock' && req.method === 'PUT') {
        poolComment = new URLSearchParams(Buffer.concat(chunks).toString()).get('comment')
        return json(200, null)
      }

      const clone = /^\/api2\/json\/nodes\/n1\/qemu\/(\d+)\/clone$/.exec(p)
      if (clone && req.method === 'POST') {
        cloneCount += 1
        const upid = `UPID:n1:0000${cloneCount}:0:0:qmclone:${clone[1]}:root@pam:`
        return json(200, upid)
      }

      const task = /^\/api2\/json\/nodes\/n1\/tasks\/([^/]+)\/status$/.exec(p)
      if (task) {
        const upid = decodeURIComponent(task[1])
        return json(200, {
          status: stoppedTasks.has(upid) ? 'stopped' : 'running',
          exitstatus: stoppedTasks.has(upid) ? 'OK' : undefined,
        })
      }

      if (/^\/api2\/json\/nodes\/n1\/qemu\/\d+\/status\/current$/.exec(p)) {
        return json(200, { status: 'running', vmid: 1100100 })
      }

      json(501, { unhandled: p })
    })
  })
}

async function waitFor(fn: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('condition not met in time')
}

async function queuesSnapshot(): Promise<{
  classes: { name: string; running: unknown[]; waiting: unknown[] }[]
}> {
  const res = await fetch(`${adminUrl}/api/queues`, { headers: { cookie } })
  assert.equal(res.status, 200)
  return (await res.json()) as never
}

before(async () => {
  fake = fakeUpstream()
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r))
  fakePort = (fake.address() as AddressInfo).port

  const config = loadConfig({
    PROXMOX_UPSTREAM_URL: `http://127.0.0.1:${fakePort}`,
    PROXMOX_SERVICE_TOKEN: 'svc@pve!proxy=11111111-1111-1111-1111-111111111111',
    ADMIN_USER: 'admin',
    ADMIN_PASSWORD: 'test-password',
    SESSION_SECRET: 'test-secret',
    DATA_DIR: ':memory:',
    BIND_HOST: '127.0.0.1',
    DATA_PORT: '0',
    ADMIN_PORT: '0',
    SINGLETON_POOL: 'testlock',
    PROXMOX_CONSOLE_USERNAME: 'svc-console@pve',
    PROXMOX_CONSOLE_PASSWORD: 'console-pw',
  })
  app = await createApp(config)
  dataUrl = `http://127.0.0.1:${(app.dataServer.address() as AddressInfo).port}`
  const adminAddr = app.admin.server.address() as AddressInfo
  adminUrl = `http://127.0.0.1:${adminAddr.port}`
})

after(async () => {
  await app.close()
  await new Promise<void>((r) => fake.close(() => r()))
})

test('singleton lock is claimed in the cluster', () => {
  assert.ok(poolComment, 'pool marker written')
  const marker = JSON.parse(poolComment!) as { i: string }
  assert.equal(marker.i, app.config.instanceId)
})

test('admin login and key issuance', async () => {
  const bad = await fetch(`${adminUrl}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'wrong' }),
  })
  assert.equal(bad.status, 401)

  const res = await fetch(`${adminUrl}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password' }),
  })
  assert.equal(res.status, 200)
  cookie = (res.headers.get('set-cookie') ?? '').split(';')[0]
  assert.ok(cookie.startsWith('pp_session='))

  const unauthed = await fetch(`${adminUrl}/api/keys`)
  assert.equal(unauthed.status, 401)

  const created = await fetch(`${adminUrl}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'app-a', vmidRanges: [[1100000, 1100999]], comment: 'e2e' }),
  })
  assert.equal(created.status, 201)
  appToken = ((await created.json()) as { token: string }).token
  assert.ok(appToken.startsWith('PVEAPIToken=svc-proxy@pve!app-a='))
})

test('runtime settings are panel-managed and hot-applied', async () => {
  const before = await fetch(`${adminUrl}/api/settings`, { headers: { cookie } })
  assert.equal(before.status, 200)
  const { settings, defaults } = (await before.json()) as {
    settings: { cloneCap: number }
    defaults: { cloneCap: number }
  }
  assert.equal(settings.cloneCap, defaults.cloneCap)

  const updated = await fetch(`${adminUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ cloneCap: 1, maxQueue: 2, maxHoldMs: 3000, taskPollMs: 250 }),
  })
  assert.equal(updated.status, 200)
  const after = (await updated.json()) as { settings: { cloneCap: number; taskPollMs: number } }
  assert.equal(after.settings.cloneCap, 1)
  assert.equal(after.settings.taskPollMs, 250)

  const bad = await fetch(`${adminUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ taskPollMs: 1 }),
  })
  assert.equal(bad.status, 400)

  // The hot-applied cap must be visible in the queue snapshot.
  const snap = await queuesSnapshot()
  assert.equal((snap.classes.find((c) => c.name === 'clone') as { cap?: number }).cap, 1)
})

test('data plane auth and scoping', async () => {
  const noAuth = await fetch(`${dataUrl}/api2/json/version`)
  assert.equal(noAuth.status, 401)

  const ok = await fetch(`${dataUrl}/api2/json/version`, {
    headers: { authorization: appToken },
  })
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { data: { version: '8.4.1' } })

  const inRange = await fetch(`${dataUrl}/api2/json/nodes/n1/qemu/1100100/status/current`, {
    headers: { authorization: appToken },
  })
  assert.equal(inRange.status, 200)

  const outOfRange = await fetch(`${dataUrl}/api2/json/nodes/n1/qemu/999/status/current`, {
    headers: { authorization: appToken },
  })
  assert.equal(outOfRange.status, 403)

  const writeNoVmid = await fetch(`${dataUrl}/api2/json/nodes/n1/qemu`, {
    method: 'POST',
    headers: { authorization: appToken },
    body: '',
  })
  assert.equal(writeNoVmid.status, 403)

  const access = await fetch(`${dataUrl}/api2/json/access/users`, {
    headers: { authorization: appToken },
  })
  assert.equal(access.status, 403)
})

test('whoami and health', async () => {
  const who = await fetch(`${dataUrl}/proxy/whoami`, { headers: { authorization: appToken } })
  assert.equal(who.status, 200)
  const body = (await who.json()) as { name: string; vmidRanges: number[][] }
  assert.equal(body.name, 'app-a')
  assert.deepEqual(body.vmidRanges, [[1100000, 1100999]])

  // The first upstream health check is async: poll instead of racing it
  // (generous budget, the suite runs files in parallel).
  await waitFor(async () => {
    const health = await fetch(`${dataUrl}/proxy/health`)
    assert.equal(health.status, 200)
    const h = (await health.json()) as { status: string }
    return h.status === 'ok'
  }, 10_000)
})

test('clone newid outside the key ranges is denied', async () => {
  const res = await fetch(`${dataUrl}/api2/json/nodes/n1/qemu/1100050/clone`, {
    method: 'POST',
    headers: { authorization: appToken, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'newid=2200100',
  })
  assert.equal(res.status, 403)
})

test('clone admission: slot held until the task stops, second clone queues', async () => {
  const clone = (newid: number): Promise<Response> =>
    fetch(`${dataUrl}/api2/json/nodes/n1/qemu/1100050/clone`, {
      method: 'POST',
      headers: { authorization: appToken, 'content-type': 'application/x-www-form-urlencoded' },
      body: `newid=${newid}`,
    })

  const first = await clone(1100100)
  assert.equal(first.status, 200)
  const upidA = ((await first.json()) as { data: string }).data
  assert.ok(upidA.startsWith('UPID:'))

  // The HTTP request finished but the task runs: the slot must still be held.
  await waitFor(async () => {
    const snap = await queuesSnapshot()
    return snap.classes.find((c) => c.name === 'clone')?.running.length === 1
  })

  // Second clone queues behind the running task (cap 1).
  const secondPromise = clone(1100101)
  await waitFor(async () => {
    const snap = await queuesSnapshot()
    return snap.classes.find((c) => c.name === 'clone')?.waiting.length === 1
  })

  // Finish task A: the poller frees the slot and B goes through.
  stoppedTasks.add(upidA)
  const second = await secondPromise
  assert.equal(second.status, 200)
  const upidB = ((await second.json()) as { data: string }).data
  stoppedTasks.add(upidB)

  await waitFor(async () => {
    const snap = await queuesSnapshot()
    const cls = snap.classes.find((c) => c.name === 'clone')
    return cls?.running.length === 0 && cls.waiting.length === 0
  })
})

test('operations were recorded', async () => {
  const res = await fetch(`${adminUrl}/api/operations?limit=100`, { headers: { cookie } })
  assert.equal(res.status, 200)
  const { rows } = (await res.json()) as {
    rows: {
      opClass: string | null
      status: number | null
      upid: string | null
      note: string | null
    }[]
  }
  const clones = rows.filter((r) => r.opClass === 'clone' && r.status === 200)
  assert.equal(clones.length, 2)
  assert.ok(clones.every((r) => r.upid?.startsWith('UPID:')))
  // The task poller back-filled the outcome of at least one finished task.
  await waitFor(async () => {
    const res2 = await fetch(`${adminUrl}/api/operations?limit=100`, { headers: { cookie } })
    const body = (await res2.json()) as { rows: { opClass: string | null; note: string | null }[] }
    return body.rows.some((r) => r.opClass === 'clone' && r.note === 'OK')
  })
})

test('console-session mints credentials for in-scope vms only', async () => {
  const mint = (vmid: number): Promise<Response> =>
    fetch(`${dataUrl}/proxy/console-session`, {
      method: 'POST',
      headers: { authorization: appToken, 'content-type': 'application/json' },
      body: JSON.stringify({ node: 'n1', vmid }),
    })

  const ok = await mint(1100100)
  assert.equal(ok.status, 200)
  const session = (await ok.json()) as {
    port: string
    ticket: string
    cookie: string
    websocketBase: string
    expiresAt: number
  }
  assert.equal(session.port, '5901')
  assert.equal(session.ticket, 'VNCTICKET-1100100')
  assert.equal(session.cookie, 'FAKE-AUTH-COOKIE')
  assert.ok(session.websocketBase.startsWith('http'))
  assert.ok(session.expiresAt > Date.now())

  const denied = await mint(999)
  assert.equal(denied.status, 403)

  const badBody = await fetch(`${dataUrl}/proxy/console-session`, {
    method: 'POST',
    headers: { authorization: appToken, 'content-type': 'application/json' },
    body: 'not-json',
  })
  assert.equal(badBody.status, 400)

  const noAuth = await fetch(`${dataUrl}/proxy/console-session`, {
    method: 'POST',
    body: JSON.stringify({ node: 'n1', vmid: 1100100 }),
  })
  assert.equal(noAuth.status, 401)
})

test('openapi document is served', async () => {
  const res = await fetch(`${adminUrl}/api/openapi.json`)
  assert.equal(res.status, 200)
  const spec = (await res.json()) as { openapi: string; paths: Record<string, unknown> }
  assert.ok(spec.openapi.startsWith('3.1'))
  assert.ok(spec.paths['/api/keys'])
})

test('per-app inventory groups cluster VMs by key ranges', async () => {
  const res = await fetch(`${adminUrl}/api/inventory`, { headers: { cookie } })
  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    apps: { name: string; vms: { vmid: number }[] }[]
    unassigned: { vmid: number }[]
    upstreamOk: boolean
  }
  assert.equal(body.upstreamOk, true)
  const appA = body.apps.find((a) => a.name === 'app-a')
  assert.deepEqual(
    appA?.vms.map((v) => v.vmid),
    [1100100],
  )
  // The out-of-range VM belongs to no key: it surfaces as unassigned residue.
  assert.deepEqual(
    body.unassigned.map((v) => v.vmid),
    [4242],
  )
})

test('red button stops a running task through the proxy', async () => {
  const upid = 'UPID:n1:00099:0:0:qmclone:1100200:root@pam:'
  const res = await fetch(`${adminUrl}/api/tasks/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ upid }),
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { node: string; stopped: boolean }
  assert.equal(body.node, 'n1')
  assert.equal(body.stopped, true)

  const bad = await fetch(`${adminUrl}/api/tasks/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ upid: 'not-a-upid' }),
  })
  assert.equal(bad.status, 400)
})

// Must run last: it shuts the app down. Regression test for the deploy bug
// where a live SSE stream kept the server from closing and the process died
// before releasing the cluster lock, blocking the successor for staleMs.
test('shutdown stays fast with an open SSE stream and releases the lock', async () => {
  const sse = await fetch(`${adminUrl}/api/events`, { headers: { cookie } })
  assert.equal(sse.status, 200)

  const started = Date.now()
  await app.close()
  const elapsed = Date.now() - started
  assert.ok(elapsed < 5000, `close took ${elapsed}ms with an SSE client attached`)

  const marker = JSON.parse(poolComment ?? '{}') as { t: number }
  assert.equal(marker.t, 0, 'lock marker marked stale for instant successor takeover')
})
