import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { createApp, type App } from '../src/app.js'
import { loadConfig, type Config } from '../src/config.js'
import { RESTORE_PENDING_FILE } from '../src/db.js'

/**
 * Backup and restore roundtrip: the durable state survives a full-overwrite
 * migration. An app boots on a real data dir, takes a backup, mutates its
 * state, restores the backup (staged file + restart request), and a SECOND
 * boot on the same dir must come back with exactly the backed-up state.
 */

let fake: Server
let fakePort = 0
let dataDir = ''

function makeConfig(): Config {
  return loadConfig({
    PROXMOX_UPSTREAM_URL: `http://127.0.0.1:${fakePort}`,
    PROXMOX_SERVICE_TOKEN: 'svc@pve!proxy=11111111-1111-1111-1111-111111111111',
    ADMIN_USER: 'admin',
    ADMIN_PASSWORD: 'test-password',
    SESSION_SECRET: 'test-secret',
    DATA_DIR: dataDir,
    BIND_HOST: '127.0.0.1',
    EDGE_PORT: '0',
    SINGLETON_DISABLED: 'true',
  })
}

async function login(url: string): Promise<string> {
  const res = await fetch(`${url}/api/session`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-password' }),
  })
  assert.equal(res.status, 200)
  return (res.headers.get('set-cookie') ?? '').split(';')[0]
}

function urlOf(app: App): string {
  return `http://127.0.0.1:${(app.edge.address() as AddressInfo).port}`
}

before(async () => {
  // Minimal quiet upstream: version for health, an empty task list for the
  // admission backstop poll. Nothing else is touched by this suite.
  fake = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [] }))
  })
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r))
  fakePort = (fake.address() as AddressInfo).port
  dataDir = mkdtempSync(join(tmpdir(), 'pp-backup-'))
})

after(async () => {
  await new Promise<void>((r) => fake.close(() => r()))
  rmSync(dataDir, { recursive: true, force: true })
})

test('full backup and restore roundtrip across boots', async () => {
  let restartRequested = false
  const appA = await createApp(makeConfig(), undefined, () => {
    restartRequested = true
  })
  const urlA = urlOf(appA)
  const cookieA = await login(urlA)

  // State worth migrating: one app key and one non-default setting.
  const mk = await fetch(`${urlA}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieA },
    body: JSON.stringify({ name: 'app-mig', vmidRanges: [[2000000, 2000099]] }),
  })
  assert.equal(mk.status, 201)
  const set = await fetch(`${urlA}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: cookieA },
    body: JSON.stringify({ cloneCap: 7 }),
  })
  assert.equal(set.status, 200)

  // The backup is a real SQLite file.
  const backupRes = await fetch(`${urlA}/api/backup`, { headers: { cookie: cookieA } })
  assert.equal(backupRes.status, 200)
  assert.match(backupRes.headers.get('content-disposition') ?? '', /attachment/)
  const backup = Buffer.from(await backupRes.arrayBuffer())
  assert.ok(backup.length > 4096, 'backup has substance')
  assert.equal(backup.subarray(0, 15).toString('latin1'), 'SQLite format 3')

  // Mutate AFTER the backup: this state must be wiped by the restore.
  const extra = await fetch(`${urlA}/api/keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieA },
    body: JSON.stringify({ name: 'app-extra', vmidRanges: [[2100000, 2100099]] }),
  })
  assert.equal(extra.status, 201)
  const set2 = await fetch(`${urlA}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', cookie: cookieA },
    body: JSON.stringify({ cloneCap: 3 }),
  })
  assert.equal(set2.status, 200)

  // Garbage is refused before anything is staged.
  const bad = await fetch(`${urlA}/api/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', cookie: cookieA },
    body: Buffer.alloc(2048, 7),
  })
  assert.equal(bad.status, 400)
  assert.ok(!existsSync(join(dataDir, RESTORE_PENDING_FILE)))

  // The real restore stages the file and asks the host for a restart.
  const restore = await fetch(`${urlA}/api/restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', cookie: cookieA },
    body: backup,
  })
  assert.equal(restore.status, 200)
  assert.deepEqual(await restore.json(), { restarting: true })
  assert.ok(existsSync(join(dataDir, RESTORE_PENDING_FILE)))
  const deadline = Date.now() + 3000
  while (!restartRequested && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25))
  }
  assert.ok(restartRequested, 'restart was requested')
  await appA.close()

  // Second boot on the same data dir: the staged backup becomes the database.
  const appB = await createApp(makeConfig())
  try {
    const urlB = urlOf(appB)
    const cookieB = await login(urlB)
    assert.ok(!existsSync(join(dataDir, RESTORE_PENDING_FILE)), 'pending file consumed')

    const keysRes = await fetch(`${urlB}/api/keys`, { headers: { cookie: cookieB } })
    const { keys } = (await keysRes.json()) as { keys: { name: string }[] }
    const names = keys.map((k) => k.name)
    assert.ok(names.includes('app-mig'), 'backed-up key restored')
    assert.ok(!names.includes('app-extra'), 'post-backup key wiped by the overwrite')

    const settingsRes = await fetch(`${urlB}/api/settings`, { headers: { cookie: cookieB } })
    const { settings } = (await settingsRes.json()) as { settings: { cloneCap: number } }
    assert.equal(settings.cloneCap, 7, 'backed-up setting restored')

    // Pull token: authorizes the backup download with a single header, nothing
    // else; a wrong token or a disabled one is a 401.
    const noAuth = await fetch(`${urlB}/api/backup`)
    assert.equal(noAuth.status, 401)
    const minted = await fetch(`${urlB}/api/backup-token`, {
      method: 'POST',
      headers: { cookie: cookieB },
    })
    assert.equal(minted.status, 200)
    const { token } = (await minted.json()) as { token: string }
    assert.match(token, /^pbt_/)
    const pulled = await fetch(`${urlB}/api/backup`, { headers: { 'x-backup-token': token } })
    assert.equal(pulled.status, 200)
    const bytes = Buffer.from(await pulled.arrayBuffer())
    assert.equal(bytes.subarray(0, 15).toString('latin1'), 'SQLite format 3')
    const wrong = await fetch(`${urlB}/api/backup`, { headers: { 'x-backup-token': 'pbt_nope' } })
    assert.equal(wrong.status, 401)
    // The token opens the backup only, not the rest of the API.
    const scoped = await fetch(`${urlB}/api/keys`, { headers: { 'x-backup-token': token } })
    assert.equal(scoped.status, 401)
    const disabled = await fetch(`${urlB}/api/backup-token`, {
      method: 'DELETE',
      headers: { cookie: cookieB },
    })
    assert.equal(disabled.status, 204)
    const afterDisable = await fetch(`${urlB}/api/backup`, {
      headers: { 'x-backup-token': token },
    })
    assert.equal(afterDisable.status, 401)
  } finally {
    await appB.close()
  }
})
