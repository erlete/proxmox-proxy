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
// When set, every task reports finished on its first poll: lets the linked-clone
// orchestrator (which waits for each clone task) run without hand-stopping UPIDs.
let autoCompleteTasks = false
const putConfigs: { vmid: number; net0: string }[] = []
const deletedVms = new Set<number>()
// VMIDs the fixture has "cloned" into existence, so group ops can act on them.
const createdVms = new Set<number>()
// Records POST /status/{action} calls the proxy forwarded for group power ops.
const powerCalls: { vmid: number; action: string }[] = []
// Cluster-wide task list served to the proxy's backstop poll. Tests push a
// running vncproxy row here to simulate a live console (the stream guard).
let clusterTasks: Record<string, unknown>[] = []
// VMIDs hidden from /cluster/resources ONLY: simulates the propagation lag a
// freshly created VM shows in the cluster view while the node already has it.
const omitFromResources = new Set<number>()

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

      // Backstop poll: out-of-band load and live consoles, test-controlled.
      if (p === '/api2/json/cluster/tasks') return json(200, clusterTasks)

      // Cluster inventory: a template and a VM inside app-a's range, one outside.
      if (p === '/api2/json/cluster/resources') {
        return json(
          200,
          [
            {
              vmid: 1100001,
              node: 'n1',
              name: 'tmpl-a',
              status: 'stopped',
              type: 'qemu',
              template: 1,
            },
            { vmid: 1100100, node: 'n1', name: 'app-vm', status: 'running', type: 'qemu' },
            { vmid: 4242, node: 'n1', name: 'stray-vm', status: 'stopped', type: 'qemu' },
            ...[...createdVms].map((vmid) => ({
              vmid,
              node: 'n1',
              name: `pod-${vmid}`,
              status: 'running',
              type: 'qemu',
            })),
          ].filter((vm) => !deletedVms.has(vm.vmid) && !omitFromResources.has(vm.vmid)),
        )
      }

      // Guest list on the node (node-local, config-derived: no propagation lag,
      // so created VMs appear here even when omitFromResources hides them from
      // the cluster view). The group destroy trusts THIS list for existence.
      if (p === '/api2/json/nodes/n1/qemu' && req.method === 'GET') {
        return json(200, [
          { vmid: 1100001, name: 'tmpl-a', status: 'stopped', template: 1 },
          { vmid: 1100100, name: 'app-vm', status: 'running' },
          { vmid: 4242, name: 'stray-vm', status: 'stopped' },
          ...[...createdVms]
            .filter((vmid) => !deletedVms.has(vmid))
            .map((vmid) => ({ vmid, name: `pod-${vmid}`, status: 'running' })),
        ])
      }

      // Storage content (filtered to the key's range by the proxy).
      if (p === '/api2/json/nodes/n1/storage/local/content' && req.method === 'GET') {
        return json(200, [
          { volid: 'local:iso/ubuntu.iso', content: 'iso' }, // no vmid: infra
          { volid: 'local:1100100/vm-1100100-disk-0', content: 'images', vmid: 1100100 },
          { volid: 'local:4242/vm-4242-disk-0', content: 'images', vmid: 4242 },
        ])
      }

      // Task list on the node (filtered to the key's range by the proxy).
      if (p === '/api2/json/nodes/n1/tasks' && req.method === 'GET') {
        return json(200, [
          { upid: 'UPID:n1:1:0:0:qmclone:1100100:root@pam:', id: '1100100', type: 'qmclone' },
          { upid: 'UPID:n1:2:0:0:qmclone:4242:root@pam:', id: '4242', type: 'qmclone' },
          { upid: 'UPID:n1:3:0:0:aptupdate::root@pam:', id: '', type: 'aptupdate' },
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
        const newid = new URLSearchParams(Buffer.concat(chunks).toString()).get('newid') ?? clone[1]
        createdVms.add(Number(newid))
        // A real qmclone UPID carries the SOURCE (template) vmid, NOT the created
        // one, so the app must read the new id from the x-proxy-newid header.
        const upid = `UPID:n1:0000${cloneCount}:0:0:qmclone:${clone[1]}:root@pam:`
        return json(200, upid)
      }

      // Power ops (start/stop/shutdown/reset/suspend). The UPID must be unique
      // per CALL (not per vmid): admission holds a slot per task, and a reused
      // UPID already marked stopped would release the new slot instantly.
      const power = /^\/api2\/json\/nodes\/n1\/qemu\/(\d+)\/status\/(\w+)$/.exec(p)
      if (power && req.method === 'POST' && power[2] !== 'current') {
        powerCalls.push({ vmid: Number(power[1]), action: power[2] })
        return json(200, `UPID:n1:0p${powerCalls.length}:0:0:qm${power[2]}:${power[1]}:root@pam:`)
      }

      // VM config read/write (linked-clone reads net0, then retags it).
      const cfg = /^\/api2\/json\/nodes\/n1\/qemu\/(\d+)\/config$/.exec(p)
      if (cfg && req.method === 'GET') {
        return json(200, { net0: 'virtio=AA:BB:CC:DD:EE:FF,bridge=vmbr0,tag=1' })
      }
      if (cfg && req.method === 'PUT') {
        const net0 = new URLSearchParams(Buffer.concat(chunks).toString()).get('net0') ?? ''
        putConfigs.push({ vmid: Number(cfg[1]), net0 })
        return json(200, null)
      }

      // VM delete (template guard blocks templates before this is ever reached).
      const delVm = /^\/api2\/json\/nodes\/n1\/qemu\/(\d+)$/.exec(p)
      if (delVm && req.method === 'DELETE') {
        deletedVms.add(Number(delVm[1]))
        return json(200, `UPID:n1:00${cloneCount}:0:0:qmdestroy:${delVm[1]}:root@pam:`)
      }

      const task = /^\/api2\/json\/nodes\/n1\/tasks\/([^/]+)\/status$/.exec(p)
      if (task) {
        const upid = decodeURIComponent(task[1])
        const stopped = stoppedTasks.has(upid) || autoCompleteTasks
        return json(200, {
          status: stopped ? 'stopped' : 'running',
          exitstatus: stopped ? 'OK' : undefined,
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
    EDGE_PORT: '0',
    SINGLETON_POOL: 'testlock',
    PROXMOX_CONSOLE_USERNAME: 'svc-console@pve',
    PROXMOX_CONSOLE_PASSWORD: 'console-pw',
  })
  app = await createApp(config)
  // One edge port multiplexes both planes by path, so both URLs are the same.
  const edgeAddr = app.edge.address() as AddressInfo
  dataUrl = `http://127.0.0.1:${edgeAddr.port}`
  adminUrl = dataUrl
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
  createdVms.clear() // assert against the base fixture, not clones from earlier tests
  const res = await fetch(`${adminUrl}/api/inventory`, { headers: { cookie } })
  assert.equal(res.status, 200)
  const body = (await res.json()) as {
    apps: { name: string; vms: { vmid: number }[] }[]
    unassigned: { vmid: number }[]
    upstreamOk: boolean
  }
  assert.equal(body.upstreamOk, true)
  const appA = body.apps.find((a) => a.name === 'app-a')
  // The template and the live VM both fall in app-a's range, sorted by vmid.
  assert.deepEqual(
    appA?.vms.map((v) => v.vmid),
    [1100001, 1100100],
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

test('reserved ranges are enforced as configuration, not per-operation', async () => {
  // A reserved range that overlaps an existing key's ranges is rejected: the
  // guard is config-level (an app range may never include a reserved VMID).
  const clash = await fetch(`${adminUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ reserved: [[1100200, 1100200]] }),
  })
  assert.equal(clash.status, 400)

  // A reserved range disjoint from every key is accepted.
  const set = await fetch(`${adminUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ reserved: [[1200000, 1200099]] }),
  })
  assert.equal(set.status, 200)

  // A new key whose ranges overlap the reserved range is rejected.
  const clashKey = await fetch(`${adminUrl}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'app-reserved-clash', vmidRanges: [[1200050, 1200150]] }),
  })
  assert.equal(clashKey.status, 400)

  // A key disjoint from the reserved range is accepted.
  const okKey = await fetch(`${adminUrl}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'app-reserved-ok', vmidRanges: [[1300000, 1300099]] }),
  })
  assert.equal(okKey.status, 201)

  // Because reserved can never overlap a key, an app operation on its own
  // in-range VMID is unaffected by reserved config.
  const ok = await fetch(`${dataUrl}/api2/json/nodes/n1/qemu/1100100/status/current`, {
    headers: { authorization: appToken },
  })
  assert.equal(ok.status, 200)

  // Clear so later tests are unaffected.
  const clear = await fetch(`${adminUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ reserved: [] }),
  })
  assert.equal(clear.status, 200)
})

test('range overlap between apps is default-deny with explicit consent', async () => {
  // Accidental sharing is how one platform destroys another's machines (the
  // LigaFP incident: six keys created with identical ranges), so an overlap
  // with a live key is refused NAMING the clash. Deliberate sharing (the same
  // logical service from several environments) stays possible, but it must be
  // said with allowSharedRange, never stumbled into.
  const first = await fetch(`${adminUrl}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'app-overlap-a', vmidRanges: [[1500000, 1500099]] }),
  })
  assert.equal(first.status, 201)

  const refused = await fetch(`${adminUrl}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'app-overlap-b', vmidRanges: [[1500050, 1500150]] }),
  })
  assert.equal(refused.status, 400)
  const refusal = (await refused.json()) as { message: string }
  assert.match(refusal.message, /app-overlap-a/)
  assert.match(refusal.message, /allowSharedRange/)

  const consented = await fetch(`${adminUrl}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      name: 'app-overlap-b',
      vmidRanges: [[1500050, 1500150]],
      allowSharedRange: true,
    }),
  })
  assert.equal(consented.status, 201)

  // The flag never overrides the reserved boundary.
  const reservedSet = await fetch(`${adminUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ reserved: [[1600000, 1600099]] }),
  })
  assert.equal(reservedSet.status, 200)
  const reservedClash = await fetch(`${adminUrl}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      name: 'app-overlap-c',
      vmidRanges: [[1600050, 1600150]],
      allowSharedRange: true,
    }),
  })
  assert.equal(reservedClash.status, 400)
  const clear = await fetch(`${adminUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ reserved: [] }),
  })
  assert.equal(clear.status, 200)
})

test('stream guard: a live console serializes heavy ops; none = caps apply', async () => {
  const clone = (newid: number): Promise<Response> =>
    fetch(`${dataUrl}/api2/json/nodes/n1/qemu/1100050/clone`, {
      method: 'POST',
      headers: { authorization: appToken, 'content-type': 'application/x-www-form-urlencoded' },
      body: `newid=${newid}`,
    })
  const cloneClass = async (): Promise<{ running: unknown[]; waiting: unknown[] }> => {
    const snap = await queuesSnapshot()
    return snap.classes.find((c) => c.name === 'clone') as {
      running: unknown[]
      waiting: unknown[]
    }
  }

  // Cap 2, no pacing delay: what the guard adds here is pure serialization.
  const tuned = await fetch(`${adminUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ cloneCap: 2, streamPacingMs: 0, taskPollMs: 250 }),
  })
  assert.equal(tuned.status, 200)

  try {
    // A live console on n1: a RUNNING vncproxy task (no endtime) in the poll.
    clusterTasks = [
      {
        upid: 'UPID:n1:0099:0:0:vncproxy:1100100:svc@pve:',
        type: 'vncproxy',
        node: 'n1',
        id: '1100100',
      },
    ]
    await waitFor(async () => {
      const snap = await queuesSnapshot()
      return (
        (snap as { consoles?: { node: string }[] }).consoles?.some((c) => c.node === 'n1') === true
      )
    })

    // First clone starts; the second must WAIT despite cap 2: guard serializes.
    const first = await clone(1100150)
    assert.equal(first.status, 200)
    const upidA = ((await first.json()) as { data: string }).data
    await waitFor(async () => (await cloneClass()).running.length === 1)

    const secondPromise = clone(1100151)
    await waitFor(async () => (await cloneClass()).waiting.length === 1)
    assert.equal((await cloneClass()).running.length, 1)

    // The running task finishing is what releases the serialized waiter.
    stoppedTasks.add(upidA)
    const second = await secondPromise
    assert.equal(second.status, 200)
    stoppedTasks.add(((await second.json()) as { data: string }).data)
    await waitFor(async () => {
      const cls = await cloneClass()
      return cls.running.length === 0 && cls.waiting.length === 0
    })

    // Console gone: the guard lifts and cap 2 admits two clones CONCURRENTLY.
    clusterTasks = []
    await waitFor(async () => {
      const snap = await queuesSnapshot()
      return (snap as { consoles?: unknown[] }).consoles?.length === 0
    })
    const [c1, c2] = await Promise.all([clone(1100152), clone(1100153)])
    assert.equal(c1.status, 200)
    assert.equal(c2.status, 200)
    await waitFor(async () => (await cloneClass()).running.length === 2)
    stoppedTasks.add(((await c1.json()) as { data: string }).data)
    stoppedTasks.add(((await c2.json()) as { data: string }).data)
    await waitFor(async () => (await cloneClass()).running.length === 0)
  } finally {
    clusterTasks = []
  }
})

test('power ops are free with no console and serialized under the guard', async () => {
  const power = (vmid: number): Promise<Response> =>
    fetch(`${dataUrl}/api2/json/nodes/n1/qemu/${vmid}/status/stop`, {
      method: 'POST',
      headers: { authorization: appToken },
      body: '',
    })
  const powerClass = async (): Promise<{ running: unknown[]; waiting: unknown[] }> => {
    const snap = await queuesSnapshot()
    return snap.classes.find((c) => c.name === 'power') as {
      running: unknown[]
      waiting: unknown[]
    }
  }
  const upidOf = async (res: Response): Promise<string> =>
    ((await res.json()) as { data: string }).data

  // No console: two concurrent stops run CONCURRENTLY (the cap is near
  // unlimited; the class only exists for the guard).
  const [p1, p2] = await Promise.all([power(1100100), power(1100101)])
  assert.equal(p1.status, 200)
  assert.equal(p2.status, 200)
  await waitFor(async () => (await powerClass()).running.length === 2)
  stoppedTasks.add(await upidOf(p1))
  stoppedTasks.add(await upidOf(p2))
  await waitFor(async () => (await powerClass()).running.length === 0)

  try {
    // Console live: stops on that node serialize (the measured stutter source).
    clusterTasks = [
      {
        upid: 'UPID:n1:0100:0:0:vncproxy:1100100:svc@pve:',
        type: 'vncproxy',
        node: 'n1',
        id: '1100100',
      },
    ]
    await waitFor(async () => {
      const snap = await queuesSnapshot()
      return (
        (snap as { consoles?: { node: string }[] }).consoles?.some((c) => c.node === 'n1') === true
      )
    })

    const first = await power(1100100)
    assert.equal(first.status, 200)
    const upidA = await upidOf(first)
    await waitFor(async () => (await powerClass()).running.length === 1)

    const secondPromise = power(1100101)
    await waitFor(async () => (await powerClass()).waiting.length === 1)
    assert.equal((await powerClass()).running.length, 1)

    stoppedTasks.add(upidA)
    const second = await secondPromise
    assert.equal(second.status, 200)
    stoppedTasks.add(await upidOf(second))
    await waitFor(async () => {
      const cls = await powerClass()
      return cls.running.length === 0 && cls.waiting.length === 0
    })
  } finally {
    clusterTasks = []
  }
})

test('stream guard ignores consoles on reserved vmids', async () => {
  const clone = (newid: number): Promise<Response> =>
    fetch(`${dataUrl}/api2/json/nodes/n1/qemu/1100050/clone`, {
      method: 'POST',
      headers: { authorization: appToken, 'content-type': 'application/x-www-form-urlencoded' },
      body: `newid=${newid}`,
    })
  const cloneClass = async (): Promise<{ running: unknown[] }> => {
    const snap = await queuesSnapshot()
    return snap.classes.find((c) => c.name === 'clone') as { running: unknown[] }
  }

  // Reserve an infra band away from every key range.
  const tuned = await fetch(`${adminUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ reserved: [[100, 199]], cloneCap: 2, streamPacingMs: 0, taskPollMs: 250 }),
  })
  assert.equal(tuned.status, 200)

  try {
    // An operator console on a reserved vmid: it must NOT engage the guard.
    clusterTasks = [
      { upid: 'UPID:n1:0102:0:0:vncproxy:150:root@pam:', type: 'vncproxy', node: 'n1', id: '150' },
    ]
    // Give the poller a couple of cycles, then confirm the guard stayed off.
    await new Promise((r) => setTimeout(r, 700))
    const snap = await queuesSnapshot()
    assert.equal((snap as { consoles?: unknown[] }).consoles?.length, 0)

    // Cap 2 admits two clones CONCURRENTLY despite the live reserved console.
    const [c1, c2] = await Promise.all([clone(1100170), clone(1100171)])
    assert.equal(c1.status, 200)
    assert.equal(c2.status, 200)
    await waitFor(async () => (await cloneClass()).running.length === 2)
    stoppedTasks.add(((await c1.json()) as { data: string }).data)
    stoppedTasks.add(((await c2.json()) as { data: string }).data)
    await waitFor(async () => (await cloneClass()).running.length === 0)

    // Same node, console now on an APP vmid: proves the poll pipeline was
    // live all along and only the reserved filter kept the guard off.
    clusterTasks = [
      {
        upid: 'UPID:n1:0103:0:0:vncproxy:1100100:svc@pve:',
        type: 'vncproxy',
        node: 'n1',
        id: '1100100',
      },
    ]
    await waitFor(async () => {
      const s = await queuesSnapshot()
      return (s as { consoles?: { node: string }[] }).consoles?.some((c) => c.node === 'n1') === true
    })
  } finally {
    clusterTasks = []
    const restore = await fetch(`${adminUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ reserved: [] }),
    })
    assert.equal(restore.status, 200)
  }
})

test('purge removes a revoked key record; active keys are protected', async () => {
  const mk = await fetch(`${adminUrl}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ name: 'app-z', vmidRanges: [[1400000, 1400999]] }),
  })
  assert.equal(mk.status, 201)

  // An active key cannot be purged: revoke first.
  const early = await fetch(`${adminUrl}/api/keys/app-z/purge`, {
    method: 'DELETE',
    headers: { cookie },
  })
  assert.equal(early.status, 409)

  const rev = await fetch(`${adminUrl}/api/keys/app-z`, { method: 'DELETE', headers: { cookie } })
  assert.equal(rev.status, 204)
  const purge = await fetch(`${adminUrl}/api/keys/app-z/purge`, {
    method: 'DELETE',
    headers: { cookie },
  })
  assert.equal(purge.status, 204)

  const list = await fetch(`${adminUrl}/api/keys`, { headers: { cookie } })
  const { keys } = (await list.json()) as { keys: { name: string }[] }
  assert.ok(!keys.some((k) => k.name === 'app-z'))

  const missing = await fetch(`${adminUrl}/api/keys/app-z/purge`, {
    method: 'DELETE',
    headers: { cookie },
  })
  assert.equal(missing.status, 404)
})

test('opacity: cluster list reads are filtered to the key ranges', async () => {
  createdVms.clear() // assert against the base fixture, not clones from earlier tests
  const resources = await fetch(`${dataUrl}/api2/json/cluster/resources?type=vm`, {
    headers: { authorization: appToken },
  })
  assert.equal(resources.status, 200)
  const rBody = (await resources.json()) as { data: { vmid: number }[] }
  assert.deepEqual(
    rBody.data.map((v) => v.vmid).sort((a, b) => a - b),
    [1100001, 1100100],
  )

  const guests = await fetch(`${dataUrl}/api2/json/nodes/n1/qemu`, {
    headers: { authorization: appToken },
  })
  const gBody = (await guests.json()) as { data: { vmid: number }[] }
  assert.deepEqual(
    gBody.data.map((v) => v.vmid).sort((a, b) => a - b),
    [1100001, 1100100],
  )

  const tasks = await fetch(`${dataUrl}/api2/json/nodes/n1/tasks`, {
    headers: { authorization: appToken },
  })
  const tBody = (await tasks.json()) as { data: { id: string }[] }
  // Only the task targeting an in-range VMID survives; the foreign and the
  // vmid-less cluster task are dropped.
  assert.deepEqual(
    tBody.data.map((t) => t.id),
    ['1100100'],
  )
})

test('the proxy assigns the newid when the app omits it', async () => {
  const res = await fetch(`${dataUrl}/api2/json/nodes/n1/qemu/1100001/clone`, {
    method: 'POST',
    headers: { authorization: appToken, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=auto', // no newid: the proxy must pick one
  })
  assert.equal(res.status, 200)
  // The created id comes from the x-proxy-newid header, NOT the UPID (a real
  // qmclone UPID carries the source template vmid).
  const assigned = Number(res.headers.get('x-proxy-newid'))
  const upid = ((await res.json()) as { data: string }).data
  assert.equal(Number(upid.split(':')[6]), 1100001) // UPID carries the SOURCE
  // A free id inside the key range, avoiding the template and the live VM.
  assert.ok(assigned >= 1100000 && assigned <= 1100999, `assigned ${assigned} out of range`)
  assert.ok(assigned !== 1100001 && assigned !== 1100100)

  // Free the held clone slot for later tests.
  stoppedTasks.add(upid)
  await waitFor(async () => {
    const snap = await queuesSnapshot()
    return snap.classes.find((c) => c.name === 'clone')?.running.length === 0
  })
})

test('templates are read-only through the proxy; cloning is the only write', async () => {
  const del = await fetch(`${dataUrl}/api2/json/nodes/n1/qemu/1100001`, {
    method: 'DELETE',
    headers: { authorization: appToken },
  })
  assert.equal(del.status, 403)

  const write = await fetch(`${dataUrl}/api2/json/nodes/n1/qemu/1100001/config`, {
    method: 'PUT',
    headers: { authorization: appToken, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'description=hacked',
  })
  assert.equal(write.status, 403)

  // Reading a template is fine (it is discoverable, just not mutable).
  const read = await fetch(`${dataUrl}/api2/json/nodes/n1/qemu/1100001/config`, {
    headers: { authorization: appToken },
  })
  assert.equal(read.status, 200)
})

test('linked clone: a group is cloned onto one leased VLAN, already configured', async () => {
  const range = await fetch(`${adminUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ linkedVlanRange: [1000, 1099] }),
  })
  assert.equal(range.status, 200)

  autoCompleteTasks = true
  putConfigs.length = 0
  try {
    // A non-template source is rejected before anything is created.
    const bad = await fetch(`${dataUrl}/proxy/linked-clone`, {
      method: 'POST',
      headers: { authorization: appToken, 'content-type': 'application/json' },
      body: JSON.stringify({ node: 'n1', clones: [{ template: 1100100 }] }),
    })
    assert.equal(bad.status, 400)

    const res = await fetch(`${dataUrl}/proxy/linked-clone`, {
      method: 'POST',
      headers: { authorization: appToken, 'content-type': 'application/json' },
      body: JSON.stringify({ node: 'n1', clones: [{ template: 1100001 }, { template: 1100001 }] }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      vlan: number
      clones: { template: number; vmid: number }[]
    }
    assert.ok(body.vlan >= 1000 && body.vlan <= 1099)
    assert.equal(body.clones.length, 2)
    const vmids = body.clones.map((c) => c.vmid)
    assert.equal(new Set(vmids).size, 2) // distinct
    assert.ok(vmids.every((v) => v >= 1100000 && v <= 1100999))

    // Both clones were retagged onto the leased VLAN.
    assert.equal(putConfigs.length, 2)
    assert.ok(putConfigs.every((c) => c.net0.includes(`tag=${body.vlan}`)))

    // The VLAN is now leased and visible to the operator.
    const leases = await fetch(`${adminUrl}/api/leases`, { headers: { cookie } })
    const lBody = (await leases.json()) as { leases: { vlan: number; vmids: number[] }[] }
    const lease = lBody.leases.find((l) => l.vlan === body.vlan)
    assert.ok(lease, 'lease recorded')
    assert.deepEqual(
      [...lease!.vmids].sort((a, b) => a - b),
      [...vmids].sort((a, b) => a - b),
    )
  } finally {
    autoCompleteTasks = false
    await fetch(`${adminUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ linkedVlanRange: null }),
    })
  }
})

test('group ops: one call powers and destroys the whole linked group', async () => {
  await fetch(`${adminUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ linkedVlanRange: [1000, 1099] }),
  })
  autoCompleteTasks = true
  powerCalls.length = 0
  try {
    const created = await fetch(`${dataUrl}/proxy/linked-clone`, {
      method: 'POST',
      headers: { authorization: appToken, 'content-type': 'application/json' },
      body: JSON.stringify({ node: 'n1', clones: [{ template: 1100001 }, { template: 1100001 }] }),
    })
    assert.equal(created.status, 200)
    const grp = (await created.json()) as { vlan: number; clones: { vmid: number }[] }
    const vmids = grp.clones.map((c) => c.vmid).sort((a, b) => a - b)

    // Unknown action -> 400; unknown group -> 404.
    const badAction = await fetch(`${dataUrl}/proxy/linked-clone/${grp.vlan}/frobnicate`, {
      method: 'POST',
      headers: { authorization: appToken },
    })
    assert.equal(badAction.status, 400)
    const noGroup = await fetch(`${dataUrl}/proxy/linked-clone/9999`, {
      method: 'DELETE',
      headers: { authorization: appToken },
    })
    assert.equal(noGroup.status, 404)

    // Ownership: another key cannot touch this group, even knowing its vlan.
    const otherKey = (await (
      await fetch(`${adminUrl}/api/keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name: 'app-two', vmidRanges: [[1700000, 1700099]] }),
      })
    ).json()) as { token: string }
    const foreignDestroy = await fetch(`${dataUrl}/proxy/linked-clone/${grp.vlan}`, {
      method: 'DELETE',
      headers: { authorization: otherKey.token },
    })
    assert.equal(foreignDestroy.status, 403)
    const foreignPower = await fetch(`${dataUrl}/proxy/linked-clone/${grp.vlan}/stop`, {
      method: 'POST',
      headers: { authorization: otherKey.token },
    })
    assert.equal(foreignPower.status, 403)

    // A bad method on a group path is 405, not a misroute.
    const badMethod = await fetch(`${dataUrl}/proxy/linked-clone/${grp.vlan}`, {
      method: 'PUT',
      headers: { authorization: appToken },
    })
    assert.equal(badMethod.status, 405)

    // One call stops every member.
    const stop = await fetch(`${dataUrl}/proxy/linked-clone/${grp.vlan}/stop`, {
      method: 'POST',
      headers: { authorization: appToken },
    })
    assert.equal(stop.status, 200)
    const stopBody = (await stop.json()) as { members: { vmid: number; ok: boolean }[] }
    assert.ok(stopBody.members.every((m) => m.ok))
    const stopped = powerCalls
      .filter((c) => c.action === 'stop')
      .map((c) => c.vmid)
      .sort((a, b) => a - b)
    assert.deepEqual(stopped, vmids)

    // One call destroys every member and frees the VLAN.
    const destroy = await fetch(`${dataUrl}/proxy/linked-clone/${grp.vlan}`, {
      method: 'DELETE',
      headers: { authorization: appToken },
    })
    assert.equal(destroy.status, 200)
    const dBody = (await destroy.json()) as { destroyed: number[] }
    assert.deepEqual(
      [...dBody.destroyed].sort((a, b) => a - b),
      vmids,
    )
    assert.ok(vmids.every((v) => deletedVms.has(v)))

    const leases = await fetch(`${adminUrl}/api/leases`, { headers: { cookie } })
    const lBody = (await leases.json()) as { leases: { vlan: number }[] }
    assert.ok(!lBody.leases.some((l) => l.vlan === grp.vlan), 'lease freed after destroy')
  } finally {
    autoCompleteTasks = false
    await fetch(`${adminUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ linkedVlanRange: null }),
    })
  }
})

test('group destroy trusts the node list, not the lagging cluster view', async () => {
  // Regression: /cluster/resources lags for freshly created VMs. A pod
  // destroyed seconds after provisioning had its young member reported absent
  // by the cluster view, counted as "already gone" and left RUNNING while the
  // VLAN was freed. The node-local guest list has no such lag, so a member
  // hidden from the cluster view must still be genuinely deleted.
  await fetch(`${adminUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ linkedVlanRange: [1000, 1099] }),
  })
  autoCompleteTasks = true
  try {
    const created = await fetch(`${dataUrl}/proxy/linked-clone`, {
      method: 'POST',
      headers: { authorization: appToken, 'content-type': 'application/json' },
      body: JSON.stringify({ node: 'n1', clones: [{ template: 1100001 }, { template: 1100001 }] }),
    })
    assert.equal(created.status, 200)
    const grp = (await created.json()) as { vlan: number; clones: { vmid: number }[] }
    const vmids = grp.clones.map((c) => c.vmid).sort((a, b) => a - b)

    // The youngest member has not propagated to the cluster view yet.
    omitFromResources.add(vmids[1])

    const destroy = await fetch(`${dataUrl}/proxy/linked-clone/${grp.vlan}`, {
      method: 'DELETE',
      headers: { authorization: appToken },
    })
    assert.equal(destroy.status, 200)
    const dBody = (await destroy.json()) as { destroyed: number[] }
    assert.deepEqual(
      [...dBody.destroyed].sort((a, b) => a - b),
      vmids,
    )
    // BOTH members really reached the cluster's delete endpoint: the hidden
    // one was not silently counted as gone.
    assert.ok(
      vmids.every((v) => deletedVms.has(v)),
      'the member hidden from the cluster view was genuinely deleted',
    )
  } finally {
    omitFromResources.clear()
    autoCompleteTasks = false
    await fetch(`${adminUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ linkedVlanRange: null }),
    })
  }
})

test('opacity: a percent-encoded foreign VMID cannot slip past scoping', async () => {
  // %34%32%34%32 decodes to 4242, outside app-a's range; must be denied, not
  // forwarded verbatim to a cluster that would decode and serve it.
  const res = await fetch(`${dataUrl}/api2/json/nodes/n1/qemu/%34%32%34%32/status/current`, {
    headers: { authorization: appToken },
  })
  assert.equal(res.status, 403)
})

test('encoded path separators are rejected', async () => {
  const res = await fetch(`${dataUrl}/api2/json/nodes/n1/qemu%2f4242/config`, {
    headers: { authorization: appToken },
  })
  assert.equal(res.status, 400)
})

test('pools and nextid are denied to apps', async () => {
  const pools = await fetch(`${dataUrl}/api2/json/pools`, { headers: { authorization: appToken } })
  assert.equal(pools.status, 403)
  const nextid = await fetch(`${dataUrl}/api2/json/cluster/nextid`, {
    headers: { authorization: appToken },
  })
  assert.equal(nextid.status, 403)
})

test('a task not scoped to an in-range guest is denied', async () => {
  const upid = encodeURIComponent('UPID:n1:3:0:0:aptupdate::root@pam:')
  const res = await fetch(`${dataUrl}/api2/json/nodes/n1/tasks/${upid}/status`, {
    headers: { authorization: appToken },
  })
  assert.equal(res.status, 403)
})

test('a move onto a template target is refused', async () => {
  const res = await fetch(`${dataUrl}/api2/json/nodes/n1/qemu/1100100/move_disk`, {
    method: 'POST',
    headers: { authorization: appToken, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'disk=scsi0&storage=local&target-vmid=1100001',
  })
  assert.equal(res.status, 403)
})

test('opacity: storage content is filtered to the key ranges', async () => {
  const res = await fetch(`${dataUrl}/api2/json/nodes/n1/storage/local/content`, {
    headers: { authorization: appToken },
  })
  assert.equal(res.status, 200)
  const body = (await res.json()) as { data: { volid: string; vmid?: number }[] }
  const vmids = body.data.map((v) => v.vmid).filter((v): v is number => v != null)
  assert.deepEqual(vmids, [1100100]) // foreign 4242 dropped
  assert.ok(body.data.some((v) => v.volid.includes('iso'))) // vmid-less infra kept
})

test('/proxy/health does not disclose the upstream version', async () => {
  const res = await fetch(`${dataUrl}/proxy/health`)
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assert.equal('upstream' in body, false)
  assert.ok('status' in body)
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
