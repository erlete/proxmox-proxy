import { createApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'

const config = loadConfig({
  PROXMOX_UPSTREAM_URL: 'http://127.0.0.1:1',
  PROXMOX_SERVICE_TOKEN: 'svc@pve!proxy=00000000-0000-0000-0000-000000000000',
  ADMIN_PASSWORD: 'smoke',
  SESSION_SECRET: 'smoke',
  DATA_DIR: ':memory:',
  BIND_HOST: '127.0.0.1',
  DATA_PORT: '0',
  ADMIN_PORT: '0',
  SINGLETON_DISABLED: 'true',
})
const app = await createApp(config)
const adminPort = (app.admin.server.address() as { port: number }).port
const dataPort = (app.dataServer.address() as { port: number }).port

const index = await fetch(`http://127.0.0.1:${adminPort}/`)
console.log('panel index:', index.status, (await index.text()).includes('proxmox-proxy') ? 'has title' : 'MISSING TITLE')
const health = await fetch(`http://127.0.0.1:${dataPort}/proxy/health`)
console.log('data health:', health.status, await health.text())
const adminHealth = await fetch(`http://127.0.0.1:${adminPort}/api/health`)
console.log('admin health:', adminHealth.status, await adminHealth.text())
await app.close()
