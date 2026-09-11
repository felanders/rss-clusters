'use server'

import { generateObject, gateway } from 'ai'
import { XMLParser } from 'fast-xml-parser'
import { and, desc, eq, gt, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { article, cluster, feed } from '@/lib/db/schema'

async function userId() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new Error('Unauthorized')
  return session.user.id
}

function asArray<T>(value: T | T[] | undefined) { return value === undefined ? [] : Array.isArray(value) ? value : [value] }
function text(value: unknown) {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (value && typeof value === 'object' && '#text' in value) return String((value as { '#text': unknown })['#text'] ?? '')
  return ''
}

function link(value: unknown) {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const candidate = value as { '@_href'?: unknown; '#text'?: unknown }
    return text(candidate['@_href']) || text(candidate['#text'])
  }
  return ''
}

const synthesisModel = gateway('inclusionai/ling-3.0-flash-sante')
const LOCAL_EMBEDDING_DIMENSIONS = 256
const LOCAL_CLUSTER_THRESHOLD = 0.55

type ClusterCandidate = { id: string; centroid: number[]; canonicalTitle: string; articleCount: number }

function cosineSimilarity(left: number[], right: number[]) {
  if (left.length !== right.length || left.length === 0) return 0
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftMagnitude += left[index] ** 2
    rightMagnitude += right[index] ** 2
  }
  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude)
  return denominator === 0 ? 0 : dot / denominator
}

function updatedCentroid(oldCentroid: number[], embedding: number[], articleCount: number) {
  return embedding.map((value, index) => ((oldCentroid[index] * articleCount) + value) / (articleCount + 1))
}

function generateArticleEmbedding(title: string, summary: string | null) {
  const tokens = `${title} ${(summary ?? '').slice(0, 300)}`
    .toLocaleLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2)
  const embedding = Array.from({ length: LOCAL_EMBEDDING_DIMENSIONS }, () => 0)
  for (const token of tokens) {
    let hash = 2166136261
    for (let index = 0; index < token.length; index += 1) {
      hash ^= token.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    embedding[(hash >>> 0) % LOCAL_EMBEDDING_DIMENSIONS] += 1
  }
  const magnitude = Math.sqrt(embedding.reduce((sum, value) => sum + value ** 2, 0))
  return magnitude === 0 ? embedding : embedding.map((value) => value / magnitude)
}

async function synthesizeCluster(clusterId: string, userId: string) {
  const rows = await db.select().from(article).where(and(eq(article.userId, userId), eq(article.clusterId, clusterId))).orderBy(desc(article.publishedAt)).limit(20)
  if (rows.length < 2) return
  const result = await generateObject({
    model: synthesisModel,
    schema: z.object({ canonical_title: z.string(), summary: z.array(z.string()).length(2) }),
    prompt: `You are a neutral news editor. Combine these related headlines and summaries into one concise canonical headline (max 12 words) and 2 key takeaway bullets. Return only the requested JSON fields.\n\n${rows.map((row) => `Headline: ${row.title}\nSummary: ${row.summary ?? ''}`).join('\n\n')}`,
  })
  await db.update(cluster).set({ canonicalTitle: result.object.canonical_title.slice(0, 500), summary: result.object.summary.map((item) => item.slice(0, 500)), lastUpdatedAt: new Date() }).where(and(eq(cluster.id, clusterId), eq(cluster.userId, userId)))
}

async function verifyClusterMatch(item: { title: string; summary: string | null }, candidate: ClusterCandidate, score: number, userId: string) {
  const related = await db.select({ title: article.title, summary: article.summary }).from(article).where(and(eq(article.userId, userId), eq(article.clusterId, candidate.id))).orderBy(desc(article.publishedAt)).limit(5)
  if (related.length === 0) return false
  const result = await generateObject({
    model: synthesisModel,
    schema: z.object({ related: z.boolean(), reason: z.string().max(240) }),
    prompt: `Decide whether this incoming news article reports the same real-world story as the existing cluster. Shared topic alone is not enough; require the same event, people, place, or development. Return related=true only when grouping is editorially defensible.\n\nIncoming article:\nHeadline: ${item.title}\nSummary: ${item.summary ?? ''}\n\nExisting cluster (${candidate.articleCount} articles, local similarity ${score.toFixed(3)}):\n${related.map((row) => `Headline: ${row.title}\nSummary: ${row.summary ?? ''}`).join('\n\n')}`,
  })
  return result.object.related
}

async function assignArticleToCluster(item: { id: string; userId: string; title: string; summary: string | null }, userId: string) {
  const embedding = generateArticleEmbedding(item.title, item.summary)
  const activeClusters = await db.select({ id: cluster.id, centroid: cluster.centroid, canonicalTitle: cluster.canonicalTitle, articleCount: cluster.articleCount }).from(cluster).where(and(eq(cluster.userId, userId), gt(cluster.lastUpdatedAt, new Date(Date.now() - 36 * 60 * 60 * 1000))))
  const best = activeClusters.reduce<{ candidate: ClusterCandidate | null; score: number }>((result, current) => {
    const score = cosineSimilarity(embedding, current.centroid)
    return score > result.score ? { candidate: current, score } : result
  }, { candidate: null, score: -1 })
  const matchesCandidate = Boolean(best.candidate && best.score >= LOCAL_CLUSTER_THRESHOLD)
  const verified = matchesCandidate ? await verifyClusterMatch(item, best.candidate!, best.score, userId) : false
  const shouldAttach = matchesCandidate && verified
  const clusterId = shouldAttach ? best.candidate!.id : crypto.randomUUID()
  if (shouldAttach) {
    await db.update(cluster).set({ centroid: updatedCentroid(best.candidate!.centroid, embedding, best.candidate!.articleCount), articleCount: best.candidate!.articleCount + 1, lastUpdatedAt: new Date() }).where(and(eq(cluster.id, clusterId), eq(cluster.userId, userId)))
  } else {
    await db.insert(cluster).values({ id: clusterId, userId, centroid: embedding, canonicalTitle: item.title.slice(0, 500), summary: [], articleCount: 1, lastUpdatedAt: new Date(), createdAt: new Date() })
  }
  await db.update(article).set({ embedding, clusterId }).where(and(eq(article.id, item.id), eq(article.userId, userId)))
  const count = shouldAttach ? best.candidate!.articleCount + 1 : 1
  if (count >= 2) {
    try {
      await synthesizeCluster(clusterId, userId)
    } catch (error) {
      console.error('[v0] Cluster synthesis failed:', clusterId, error)
    }
  }
}

async function fetchArticles(source: string) {
  const response = await fetch(source, { headers: { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' }, signal: AbortSignal.timeout(12000), cache: 'no-store' })
  if (!response.ok) throw new Error(`Feed returned ${response.status}`)
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > 3_000_000) throw new Error('Feed is larger than 3 MB')
  const xml = await response.text()
  if (xml.length > 3_000_000) throw new Error('Feed is larger than 3 MB')
  const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' }).parse(xml)
  const rss = parsed?.rss?.channel
  const atom = parsed?.feed
  const items = rss ? asArray(rss.item) : asArray(atom?.entry)
  return { title: text(rss?.title) || text(atom?.title) || new URL(source).hostname, items: items.map((item: Record<string, unknown>) => ({ title: text(item.title) || 'Untitled article', url: link(item.link) || text(item.guid) || text(item.id), summary: text(item.description) || text(item.summary) || text(item.content), author: text(item.author) || text((item.author as Record<string, unknown> | undefined)?.name), publishedAt: text(item.pubDate) || text(item.published) || text(item.updated), guid: text(item.guid) || text(item.id) })).filter((item) => item.url) }
}

export async function listFeeds() {
  const id = await userId()
  return db.select().from(feed).where(eq(feed.userId, id)).orderBy(desc(feed.createdAt))
}

export async function listArticles() {
  const id = await userId()
  return db.select().from(article).where(eq(article.userId, id)).orderBy(desc(article.publishedAt), desc(article.createdAt)).limit(100)
}

export async function listClusters() {
  const id = await userId()
  return db.select().from(cluster).where(eq(cluster.userId, id)).orderBy(desc(cluster.lastUpdatedAt))
}

export async function reclusterArticles() {
  const id = await userId()
  const rows = await db.select({ id: article.id, userId: article.userId, title: article.title, summary: article.summary }).from(article).where(and(eq(article.userId, id), isNull(article.clusterId)))
  let processed = 0
  for (const item of rows) {
    try {
      await assignArticleToCluster(item, id)
      processed += 1
    } catch (error) {
      console.error('[v0] Article clustering failed:', item.id, error)
    }
  }
  revalidatePath('/')
  return { processed, total: rows.length }
}

export async function addFeed(rawUrl: string) {
  const id = await userId()
  const normalized = rawUrl.trim().startsWith('http') ? rawUrl.trim() : `https://${rawUrl.trim()}`
  const parsed = new URL(normalized)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) feed URLs are supported')
  const existing = await db.select({ id: feed.id }).from(feed).where(and(eq(feed.userId, id), eq(feed.url, parsed.toString())))
  if (existing.length) throw new Error('That feed is already in your newsroom.')
  const now = new Date()
  const row = { id: crypto.randomUUID(), userId: id, name: parsed.hostname.replace(/^www\./, ''), url: parsed.toString(), category: 'Uncategorized', status: 'Pending sync', lastSyncedAt: null, lastError: null, createdAt: now, updatedAt: now }
  await db.insert(feed).values(row)
  await refreshFeed(row.id)
  revalidatePath('/')
  return row
}

export async function updateFeed(feedId: string, values: { name?: string; category?: string }) {
  const id = await userId()
  await db.update(feed).set({ ...(values.name?.trim() ? { name: values.name.trim() } : {}), ...(values.category?.trim() ? { category: values.category.trim() } : {}), updatedAt: new Date() }).where(and(eq(feed.id, feedId), eq(feed.userId, id)))
  revalidatePath('/')
}

export async function deleteFeed(feedId: string) {
  const id = await userId()
  await db.delete(article).where(and(eq(article.feedId, feedId), eq(article.userId, id)))
  await db.delete(feed).where(and(eq(feed.id, feedId), eq(feed.userId, id)))
  revalidatePath('/')
}

export async function refreshFeed(feedId: string) {
  const id = await userId()
  const rows = await db.select().from(feed).where(and(eq(feed.id, feedId), eq(feed.userId, id)))
  const current = rows[0]
  if (!current) throw new Error('Feed not found')
  try {
    const result = await fetchArticles(current.url)
    const now = new Date()
    for (const item of result.items.slice(0, 100)) {
      const inserted = await db.insert(article).values({ id: crypto.randomUUID(), feedId: current.id, userId: id, title: item.title.slice(0, 500), url: item.url.slice(0, 2000), summary: item.summary.slice(0, 5000) || null, author: item.author.slice(0, 300) || null, publishedAt: item.publishedAt ? new Date(item.publishedAt) : null, guid: item.guid.slice(0, 1000) || null }).onConflictDoNothing({ target: [article.feedId, article.url] }).returning({ id: article.id, title: article.title, summary: article.summary })
      if (inserted[0]) {
        try {
          await assignArticleToCluster({ ...inserted[0], userId: id }, id)
        } catch (error) {
          console.error('[v0] Article embedding failed:', inserted[0].id, error)
        }
      }
    }
    const defaultName = new URL(current.url).hostname.replace(/^www\./, '')
    const nextName = current.name === defaultName ? result.title.slice(0, 200) : current.name
    await db.update(feed).set({ name: nextName, status: 'Healthy', lastSyncedAt: now, lastError: null, updatedAt: now }).where(and(eq(feed.id, feedId), eq(feed.userId, id)))
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to refresh feed'
    await db.update(feed).set({ status: 'Error', lastError: message.slice(0, 500), updatedAt: new Date() }).where(and(eq(feed.id, feedId), eq(feed.userId, id)))
    throw new Error(message)
  }
  revalidatePath('/')
}

export async function refreshAllFeeds() {
  const rows = await listFeeds()
  const results = await Promise.allSettled(rows.map((item) => refreshFeed(item.id)))
  revalidatePath('/')
  return { refreshed: results.filter((result) => result.status === 'fulfilled').length, total: rows.length }
}

export async function refreshAndClusterAll() {
  const refreshResult = await refreshAllFeeds()
  const clusterResult = await reclusterArticles()
  return { ...refreshResult, ...clusterResult }
}
