import { XMLParser } from 'fast-xml-parser'

const FEED_TIMEOUT_MS = 12_000
const MAX_FEED_BYTES = 3_000_000

export type ParsedFeedItem = {
  title: string
  url: string
  summary: string
  author: string
  publishedAt: Date | null
  guid: string
}

export type ParsedFeed = { title: string; items: ParsedFeedItem[] }

type XmlNode = Record<string, unknown>

function asArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return []
  return Array.isArray(value) ? value : [value]
}

function text(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return text(value[0])
  if (value && typeof value === 'object' && '#text' in value) {
    return String((value as { '#text': unknown })['#text'] ?? '')
  }
  return ''
}

/** Resolves an RSS <link> or an Atom <link href rel>, which may be repeated. */
function link(value: unknown): string {
  const candidates = asArray(value)

  const alternate = candidates.find(
    (candidate) =>
      candidate !== null &&
      typeof candidate === 'object' &&
      ((candidate as XmlNode)['@_rel'] ?? 'alternate') === 'alternate',
  )

  for (const candidate of [alternate, ...candidates]) {
    if (typeof candidate === 'string' && candidate) return candidate
    if (candidate && typeof candidate === 'object') {
      const node = candidate as XmlNode
      const href = text(node['@_href']) || text(node['#text'])
      if (href) return href
    }
  }

  return ''
}

function parsedDate(value: string): Date | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function toItem(node: XmlNode): ParsedFeedItem {
  const author = node.author as XmlNode | undefined

  return {
    title: text(node.title) || 'Untitled article',
    url: link(node.link) || text(node.guid) || text(node.id),
    summary: text(node.description) || text(node.summary) || text(node.content),
    author: text(node.author) || text(author?.name),
    publishedAt: parsedDate(text(node.pubDate) || text(node.published) || text(node.updated)),
    guid: text(node.guid) || text(node.id),
  }
}

export function defaultFeedName(url: string) {
  return new URL(url).hostname.replace(/^www\./, '')
}

export function normalizeFeedUrl(rawUrl: string): URL {
  const trimmed = rawUrl.trim()
  if (!trimmed) throw new Error('Please enter a feed URL.')

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : 'https://' + trimmed

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error('That does not look like a valid URL.')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only HTTP(S) feed URLs are supported')
  }

  return parsed
}

export async function fetchFeed(source: string): Promise<ParsedFeed> {
  const response = await fetch(source, {
    headers: {
      accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml',
    },
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    cache: 'no-store',
  })

  if (!response.ok) throw new Error(`Feed returned ${response.status}`)

  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength > MAX_FEED_BYTES) throw new Error('Feed is larger than 3 MB')

  const xml = await response.text()
  if (xml.length > MAX_FEED_BYTES) throw new Error('Feed is larger than 3 MB')

  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' }).parse(xml)

  const rssChannel = parsed?.rss?.channel as XmlNode | undefined
  const atomFeed = parsed?.feed as XmlNode | undefined

  if (!rssChannel && !atomFeed) throw new Error('Feed is not valid RSS or Atom')

  const nodes = rssChannel
    ? asArray(rssChannel.item as XmlNode | XmlNode[])
    : asArray(atomFeed?.entry as XmlNode | XmlNode[])

  return {
    title: text(rssChannel?.title) || text(atomFeed?.title) || new URL(source).hostname,
    items: nodes.map(toItem).filter((item) => Boolean(item.url)),
  }
}
