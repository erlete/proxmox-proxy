import assert from 'node:assert/strict'
import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { Upstream } from '../src/upstream/client.js'
import { SingletonHeldError, SingletonLock } from '../src/upstream/singleton.js'

/**
 * Live verification against a REAL cluster. Non-destructive by design: it
 * clones a template into a scratch VMID, verifies admission end to end, and
 * deletes the clone. Required env: PROXMOX_UPSTREAM_URL, PROXMOX_SERVICE_TOKEN,
 * VERIFY_NODE, VERIFY_TEMPLATE_VMID, VERIFY_NEWID (a VMID that must be free).
 */

const node = process.env.VERIFY_NODE ?? ''
const templateVmid = Number.parseInt(process.env.VERIFY_TEMPLATE_VMID ?? '', 10)
const newid = Number.parseInt(process.env.VERIFY_NEWID ?? '', 10)
assert.ok(
  node && templateVmid > 0 && newid > 0,
  'set VERIFY_NODE, VERIFY_TEMPLATE_VMID, VERIFY_NEWID',
)

const config = loadConfig({
  ...process.env,
  ADMIN_PASSWORD: 'verify-live',
  SESSION_SECRET: 'verify-live',
  DATA_DIR: ':memory:',
  BIND_HOST: '127.0.0.1',
  EDGE_PORT: '0',
})

const step = (msg: string): void => console.log(`\n== ${msg}`)

async function waitFor(desc: string, fn: () => Promise<boolean>, ms = 120_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error(`timeout waiting for: ${desc}`)
}

step('booting proxy against the real cluster (acquiring singleton lock)')
const app = await createApp(config)
const edgePort = (app.edge.address() as { port: number }).port
const dataUrl = `http://127.0.0.1:${edgePort}`
const adminUrl = dataUrl

try {
  step('singleton duel: a second instance must refuse to start')
  const rivalUpstream = new Upstream({
    url: config.upstreamUrl,
    caPath: config.upstreamCaPath,
    insecure: config.upstreamInsecure,
    serviceToken: config.serviceToken,
  })
  const rival = new SingletonLock(rivalUpstream, {
    poolId: config.singleton.poolId,
    instanceId: 'rival-instance',
    heartbeatMs: 60_000,
    staleMs: config.singleton.staleMs,
    onLost: () => {},
  })
  await assert.rejects(rival.acquire(), SingletonHeldError)
  await rivalUpstream.close()
  console.log('rival correctly rejected')

  step('admin login + key issuance')
  const login = await fetch(`${adminUrl}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'verify-live' }),
  })
  assert.equal(login.status, 200)
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]

  // Tighten runtime settings through the panel API (hot-applied).
  const tuned = await fetch(`${adminUrl}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ cloneCap: 1, deleteCap: 1, taskPollMs: 1000 }),
  })
  assert.equal(tuned.status, 200)

  const created = await fetch(`${adminUrl}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({
      name: 'verify-live',
      vmidRanges: [
        [templateVmid, templateVmid],
        [newid, newid],
      ],
      comment: 'live verification, throwaway',
    }),
  })
  assert.equal(created.status, 201)
  const token = ((await created.json()) as { token: string }).token
  const auth = { authorization: token }
  console.log('key issued (scoped to template + scratch vmid)')

  const queues = async (): Promise<{ name: string; running: unknown[]; waiting: unknown[] }[]> => {
    const res = await fetch(`${adminUrl}/api/queues`, { headers: { cookie } })
    return ((await res.json()) as { classes: never[] }).classes
  }

  step('passthrough: version and whoami')
  const version = await fetch(`${dataUrl}/api2/json/version`, { headers: auth })
  assert.equal(version.status, 200)
  console.log(
    'cluster version:',
    JSON.stringify(((await version.json()) as { data: unknown }).data),
  )
  const who = await fetch(`${dataUrl}/proxy/whoami`, { headers: auth })
  assert.equal(who.status, 200)
  console.log('whoami:', JSON.stringify(await who.json()))

  step('scope: a vmid outside the key ranges is denied')
  const denied = await fetch(`${dataUrl}/api2/json/nodes/${node}/qemu/1100500/status/current`, {
    headers: auth,
  })
  assert.equal(denied.status, 403)
  console.log('403 as expected')

  step(`clone template ${templateVmid} -> ${newid} through admission`)
  const clone = await fetch(`${dataUrl}/api2/json/nodes/${node}/qemu/${templateVmid}/clone`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/x-www-form-urlencoded' },
    body: `newid=${newid}&name=pp-proxy-verify`,
  })
  const cloneBody = (await clone.json()) as { data?: string }
  assert.equal(clone.status, 200, JSON.stringify(cloneBody))
  assert.ok(cloneBody.data?.startsWith('UPID:'))
  console.log('clone accepted, upid:', cloneBody.data)

  const running = (await queues()).find((c) => c.name === 'clone')
  assert.equal(running?.running.length, 1, 'clone slot held while the task runs')
  console.log('admission slot held by the running clone task')

  await waitFor('clone task to finish and release its slot', async () => {
    const cls = (await queues()).find((c) => c.name === 'clone')
    return cls?.running.length === 0
  })
  console.log('clone task finished, slot released')

  const exists = await fetch(`${dataUrl}/api2/json/nodes/${node}/qemu/${newid}/status/current`, {
    headers: auth,
  })
  assert.equal(exists.status, 200)
  console.log(
    'clone exists:',
    JSON.stringify(((await exists.json()) as { data: { status: string } }).data.status),
  )

  step(`delete the clone ${newid} through admission`)
  const del = await fetch(`${dataUrl}/api2/json/nodes/${node}/qemu/${newid}`, {
    method: 'DELETE',
    headers: auth,
  })
  const delBody = (await del.json()) as { data?: string }
  assert.equal(del.status, 200, JSON.stringify(delBody))
  console.log('delete accepted, upid:', delBody.data)

  await waitFor('delete task to finish', async () => {
    const cls = (await queues()).find((c) => c.name === 'delete')
    return cls?.running.length === 0
  })
  const gone = await fetch(`${dataUrl}/api2/json/nodes/${node}/qemu/${newid}/status/current`, {
    headers: auth,
  })
  assert.notEqual(gone.status, 200)
  console.log('clone deleted and no longer resolvable, upstream said', gone.status)

  step('recorded operations')
  const ops = await fetch(`${adminUrl}/api/operations?limit=20`, { headers: { cookie } })
  const rows = (
    (await ops.json()) as {
      rows: {
        method: string
        path: string
        opClass: string | null
        status: number | null
        queueMs: number | null
        taskMs: number | null
        note: string | null
      }[]
    }
  ).rows
  for (const r of rows) {
    console.log(
      ` ${r.method} ${r.path} class=${r.opClass ?? '-'} status=${r.status} queue=${r.queueMs}ms task=${r.taskMs ?? '-'}ms note=${r.note ?? '-'}`,
    )
  }

  console.log('\nLIVE VERIFICATION PASSED')
} finally {
  await app.close()
}
