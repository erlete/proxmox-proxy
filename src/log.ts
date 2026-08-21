type Level = 'info' | 'warn' | 'error'

function line(level: Level, msg: string, fields?: Record<string, unknown>): void {
  const ts = new Date().toISOString()
  const extra = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : ''
  const out = `${ts} [${level}] ${msg}${extra}`
  if (level === 'error') console.error(out)
  else if (level === 'warn') console.warn(out)
  else console.log(out)
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => line('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => line('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => line('error', msg, fields),
}
