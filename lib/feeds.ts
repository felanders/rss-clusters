import { XMLParser } from 'fast-xml-parser'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { article, feed } from '@/lib/db/schema'
import { clusterPendingArticles, embedPendingArticles } from '@/lib/clustering'

function asArray<T>(value: T | T[] | undefined) { return value === undefined ? [] : Array.isArray(value) ? value : [value] }
function text(value: unknown) {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (value && typeof value === 'object' && '#text' in value) return String((value as { '#text': unknown })['#text'] ?? '')
  return ''
}

function link(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(link).find((candidate) => candidate.startsWith('http')) ?? ''
  if (value && typeof value === 'object') {
    const candidate = value as { '@_href'?: unknown; '#text'?: unknown }
    return text(candidate['@_href']) || text(candidate['#text'])
  }
  return ''
}

async function fetchArticles(source: string) {
  const response = await fetch(source, { headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml', 'user-agent': 'ClusteredRSS/1.0 (+https://github.com/felanders/rss-clusters)' }, signal: AbortSignal.timeout(12000), cache: 'no-store' })
  if (!response.ok) throw new Error(`Feed returned ${response.status}`)
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > 3_000_000) throw new Error('Feed is larger than 3 MB')
  const xml = await response.text()
  if (xml.length > 3_000_000) throw new Error('Feed is larger than 3 MB')
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' }).parse(xml)
  const rss = parsed?.rss?.channel ?? parsed?.['rdf:RDF']?.channel
  const atom = parsed?.feed
  if (!rss && !atom) throw new Error('Feed is not valid RSS or Atom')
  const items = rss ? asArray(rss.item ?? parsed?.['rdf:RDF']?.item) : asArray(atom?.entry)
  return {
    title: text(rss?.title) || text(atom?.title) || new URL(source).hostname,
    items: items.map((item: Record<string, unknown>) => ({
      title: text(item.title) || 'Untitled article',
      url: link(item.link) || text(item.guid) || text(item.id),
      summary: text(item.description) || text(item.summary) || text(item['content:encoded']) || text(item.content),
      author: text(item.author) || text((item.author as Record<string, unknown> | undefined)?.name) || text(item['dc:creator']),
      publishedAt: text(item.pubDate) || text(item.published) || text(item.updated) || text(item['dc:date']),
      guid: text(item.guid) || text(item.id),
    })).filter((item) => /^https?:/.test(item.url)),
  }
}

/** Fetch one feed and store new articles. Embedding + clustering happen afterwards in syncAllFeeds so they run batched. */
export async function syncFeed(feedId: string, id: string) {
  const [current] = await db.select().from(feed).where(and(eq(feed.id, feedId), eq(feed.userId, id)))
  if (!current) throw new Error('Feed not found')
  try {
    const result = await fetchArticles(current.url)
    const now = new Date()
    const rows = result.items.slice(0, 100).map((item) => {
      const publishedAt = item.publishedAt ? new Date(item.publishedAt) : null
      return { id: crypto.randomUUID(), feedId: current.id, userId: id, title: item.title.slice(0, 500), url: item.url.slice(0, 2000), summary: item.summary.slice(0, 5000) || null, author: item.author.slice(0, 300) || null, publishedAt: publishedAt && !Number.isNaN(publishedAt.getTime()) ? publishedAt : null, guid: item.guid.slice(0, 1000) || null }
    })
    const inserted = rows.length ? await db.insert(article).values(rows).onConflictDoNothing({ target: [article.feedId, article.url] }).returning({ id: article.id }) : []
    const defaultName = new URL(current.url).hostname.replace(/^www\./, '')
    const nextName = current.name === defaultName ? result.title.slice(0, 200) : current.name
    await db.update(feed).set({ name: nextName, status: 'Healthy', lastSyncedAt: now, lastError: null, updatedAt: now }).where(and(eq(feed.id, feedId), eq(feed.userId, id)))
    return { added: inserted.length }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to refresh feed'
    await db.update(feed).set({ status: 'Error', lastError: message.slice(0, 500), updatedAt: new Date() }).where(and(eq(feed.id, feedId), eq(feed.userId, id)))
    throw new Error(message)
  }
}

export type RefreshResult = { refreshed: number; total: number; added: number; log: string[]; errors: string[] }

/** Fetch every feed, embed what is new, then cluster the new arrivals. */
export async function syncAllFeeds(id: string, options: { cluster?: boolean } = {}): Promise<RefreshResult> {
  const log: string[] = []
  const rows = await db.select().from(feed).where(eq(feed.userId, id))
  const results = await Promise.allSettled(rows.map((item) => syncFeed(item.id, id)))
  const errors = results.flatMap((result, index) => result.status === 'rejected' ? [`${rows[index].name}: ${result.reason instanceof Error ? result.reason.message : result.reason}`] : [])
  const added = results.reduce((sum, result) => sum + (result.status === 'fulfilled' ? result.value.added : 0), 0)
  log.push(`Fetched ${results.length - errors.length} of ${rows.length} feeds, ${added} new article${added === 1 ? '' : 's'}.`)
  errors.forEach((message) => log.push(`Feed error — ${message}`))
  if (options.cluster ?? true) {
    const embedding = await embedPendingArticles(id, (message) => log.push(message))
    errors.push(...embedding.errors)
    const clustering = await clusterPendingArticles(id, (message) => log.push(message))
    errors.push(...clustering.errors)
  }
  return { refreshed: results.length - errors.length, total: rows.length, added, log, errors }
}
