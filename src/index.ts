import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { log } from './log.js'
import { SingletonHeldError } from './upstream/singleton.js'

async function main(): Promise<void> {
  const config = loadConfig()

  let app: Awaited<ReturnType<typeof createApp>> | null = null
  let shuttingDown = false

  const shutdown = (code: number, reason: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    log.info('shutting down', { reason })
    const finish = (): never => process.exit(code)
    if (app) {
      void app.close().then(finish, finish)
      setTimeout(finish, 10_000).unref()
    } else {
      finish()
    }
  }

  process.on('SIGTERM', () => shutdown(0, 'SIGTERM'))
  process.on('SIGINT', () => shutdown(0, 'SIGINT'))

  try {
    app = await createApp(config, () => shutdown(1, 'cluster lock lost'))
  } catch (err) {
    if (err instanceof SingletonHeldError) {
      log.error(err.message)
      log.error('refusing to start: only one proxy may guard a cluster')
      process.exit(1)
    }
    throw err
  }
}

main().catch((err) => {
  log.error('fatal', { error: String(err instanceof Error ? (err.stack ?? err.message) : err) })
  process.exit(1)
})
