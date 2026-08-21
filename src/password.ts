import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/** Format: scrypt:<salt b64url>:<hash b64url> */
export function hashPassword(password: string): string {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64)
  return `scrypt:${salt.toString('base64url')}:${hash.toString('base64url')}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split(':')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  try {
    const salt = Buffer.from(parts[1], 'base64url')
    const expected = Buffer.from(parts[2], 'base64url')
    const got = scryptSync(password, salt, expected.length)
    return got.length === expected.length && timingSafeEqual(got, expected)
  } catch {
    return false
  }
}
