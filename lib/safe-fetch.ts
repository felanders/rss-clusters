import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * fetch() for user-supplied URLs (feeds). Refuses anything that resolves to a loopback, link-local or private address and
 * re-checks every redirect hop, so a feed URL cannot be used to reach internal services from the server.
 */

function isPrivateIp(address: string) {
  if (address.includes(':')) {
    const ip = address.toLowerCase()
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateIp(mapped[1])
    return ip === '::1' || ip === '::' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')
  }
  const [a, b] = address.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224
}

export async function assertPublicUrl(url: URL) {
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are supported')
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.') && !isIP(host)) throw new Error('Feed host is not a public address')
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((entry) => entry.address)
  if (addresses.length === 0) throw new Error('Feed host could not be resolved')
  if (addresses.some(isPrivateIp)) throw new Error('Feed host is not a public address')
}

export async function fetchPublic(input: string, init: RequestInit = {}, maxRedirects = 5) {
  let url = new URL(input)
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertPublicUrl(url)
    const response = await fetch(url, { ...init, redirect: 'manual' })
    const location = response.headers.get('location')
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, url)
      continue
    }
    return response
  }
  throw new Error('Too many redirects')
}
