export interface ParsedToken {
  tokenUser: string
  name: string
  secret: string
}

const TOKEN_RE = /^PVEAPIToken=([^!\s]+)!([^=\s]+)=(\S+)$/

/**
 * Keys issued by the proxy use the standard Proxmox token header format, so
 * any stock Proxmox SDK sends them without code changes.
 */
export function parseAuthorization(header: string | undefined): ParsedToken | null {
  if (!header) return null
  const m = TOKEN_RE.exec(header.trim())
  if (!m) return null
  return { tokenUser: m[1], name: m[2], secret: m[3] }
}
