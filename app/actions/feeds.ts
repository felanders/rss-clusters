'use server'

import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { auth } from '@/lib/auth'
import { db } from '@/lib/db'
import { article, cluster, feed } from '@/lib/db/schema'
import type { ArticleView, ClusterView } from '@/lib/db/schema'
import { clusterPendingArticles, embedPendingArticles, reclusterAll, reconcileClusters } from '@/lib/clustering'
import { syncFeed, syncAllFeeds, type RefreshResult } from '@/lib/feeds'
export type { RefreshResult } from '@/lib/feeds'

async function userId() {
  const session = await auth.api.getSession({ headers: await headers() })
  if (!session?.user) throw new Error('Unauthorized')
  return session.user.id
}

export async function listFeeds() {
  const id = await userId()
  return db.select().from(feed).where(eq(feed.userId, id)).orderBy(desc(feed.createdAt))
}

const articleView = { id: article.id, feedId: article.feedId, userId: article.userId, title: article.title, url: article.url, summary: article.summary, author: article.author, publishedAt: article.publishedAt, guid: article.guid, embeddingModel: article.embeddingModel, clusterId: article.clusterId, clusteredAt: article.clusteredAt, readAt: article.readAt, createdAt: article.createdAt }
const clusterView = { id: cluster.id, userId: cluster.userId, canonicalTitle: cluster.canonicalTitle, summary: cluster.summary, articleCount: cluster.articleCount, lastUpdatedAt: cluster.lastUpdatedAt, createdAt: cluster.createdAt }

export async function listArticles(): Promise<ArticleView[]> {
  const id = await userId()
  return db.select(articleView).from(article).where(eq(article.userId, id)).orderBy(desc(article.publishedAt), desc(article.createdAt))
}

export async function listClusters(): Promise<ClusterView[]> {
  const id = await userId()
  return db.select(clusterView).from(cluster).where(eq(cluster.userId, id)).orderBy(desc(cluster.lastUpdatedAt))
}

export async function markArticleRead(articleId: string) {
  const id = await userId()
  await db.update(article).set({ readAt: new Date() }).where(and(eq(article.id, articleId), eq(article.userId, id)))
}

export async function listReadArticleIds() {
  const id = await userId()
  const rows = await db.select({ id: article.id }).from(article).where(and(eq(article.userId, id), isNotNull(article.readAt)))
  return rows.map((row) => row.id)
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
  await syncFeed(row.id, id)
  await embedPendingArticles(id)
  await clusterPendingArticles(id)
  revalidatePath('/')
  const [saved] = await db.select().from(feed).where(eq(feed.id, row.id))
  return saved ?? row
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
  await reconcileClusters(id)
  revalidatePath('/')
}

/** Fetch every feed, embed what is new, then cluster the new arrivals. */
export async function refreshAllFeeds(): Promise<RefreshResult> {
  const id = await userId()
  const result = await syncAllFeeds(id)
  revalidatePath('/')
  return result
}

export type ReclusterResult = { embedded: number; candidates: number; clustersConfirmed: number; articlesClustered: number; log: string[]; errors: string[] }

/** Rebuild all clusters from scratch. */
export async function reclusterArticles(): Promise<ReclusterResult> {
  const id = await userId()
  const log: string[] = []
  const result = await reclusterAll(id, (message) => log.push(message))
  revalidatePath('/')
  return { embedded: result.embedded, candidates: result.candidates, clustersConfirmed: result.clustersConfirmed, articlesClustered: result.articlesClustered, log, errors: result.errors }
}
