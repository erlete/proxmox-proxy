import { X509Certificate } from 'node:crypto'
import { readFileSync } from 'node:fs'

/**
 * The CA bundle an app needs to verify the console websocket, which it opens
 * DIRECT to the node (`websocketBase`): the stream never crosses the proxy, so
 * the app has to trust the cluster's certificate itself. It is the same file
 * the proxy verifies the cluster with (`PROXMOX_UPSTREAM_TLS_CA`).
 *
 * Null when no CA file is configured: then the nodes are expected to present a
 * certificate the app already trusts (a public one behind `publicWsUrl`).
 */
export function websocketCaFrom(caPath: string | null): string | null {
  if (!caPath) return null
  return sanitizeCaBundle(readFileSync(caPath, 'utf8'))
}

/**
 * Keeps only the CA certificates (basicConstraints CA:TRUE) of a PEM bundle.
 * What goes out of the proxy is a trust anchor and nothing else: a leaf
 * certificate, a private key or any other block pasted into the file by
 * mistake never reaches an app. Null when no CA certificate is left.
 */
export function sanitizeCaBundle(pem: string): string | null {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []
  const authorities = blocks.filter((block) => {
    try {
      return new X509Certificate(block).ca
    } catch {
      return false
    }
  })
  return authorities.length > 0 ? `${authorities.join('\n')}\n` : null
}
