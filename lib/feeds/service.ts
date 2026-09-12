import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { db } from '@/lib/db'
import { article, cluster, feed } from '@/lib/db/schema'
import { errorMessage } from '@/lib/ai/openrouter'
import { generateArticleEmbeddings } from '@/lib/ai/embeddings'
import { assignArticleToCluster } from '@/lib/clustering/clusters'
import { defaultFeedName, fetchFeed, normalizeFeedUrl } from './rss'

/**
 * User-scoped domain logic. These functions take an explicit `userId` and are
 * NOT server actions, so they can be reused by the cron route without exposing
 * a user-id override to the browser.
 */

const MAX_ITEMS_PER_SYNC = 100
const EMBEDDING_BATCH_SIZE = 16
const TITLE_LIMIT = 500
const URL_LIMIT = 2_000
const SUMMARY_LIMIT = 5_000
const AUTHOR_LIMIT = 300
const GUID_LIMIT = 1_000

export type ReclusterResult = { processed: number; total: number; errors: string[] }
export type RefreshResult = { refreshed: number; total: number; errors: string[] }

export function listFeedsForUser(userId: string) {
  return db.select().from(feed).where(eq(feed.userId, userId)).orderBy(desc(feed.createdAt))
}

export function listArticlesForUser(userId: string) {
  return db
    .select()
    .from(article)
    .where(eq(article.userId, userId))
    .orderBy(desc(article.publishedAt), desc(article.createdAt))
}

export function listClustersForUser(userId: string) {
  return db
    .select()
    .from(cluster)
    .where(eq(cluster.userId, userId))
    .orderBy(desc(cluster.lastUpdatedAt))
}

export async function listReadArticleIdsForUser(userId: string) {
  const rows = await db
    .select({ id: article.id })
    .from(article)
    .where(and(eq(article.userId, userId), isNotNull(article.readAt)))

  return rows.map((row) => row.id)
}

export async function markArticleReadForUser(articleId: string, userId: string) {
  await db
    .update(article)
    .set({ readAt: new Date() })
    .where(and(eq(article.id, articleId), eq(article.userId, userId)))
}

export async function createFeedForUser(rawUrl: string, userId: string) {
  const url = normalizeFeedUrl(rawUrl).toString()

  const existing = await db
    .select({ id: feed.id })
    .from(feed)
    .where(and(eq(feed.userId, userId), eq(feed.url, url)))
    .limit(1)

  if (existing.length > 0) throw new Error('That feed is already in your newsroom.')

  const now = new Date()
  const row = {
    id: crypto.randomUUID(),
    userId,
    name: defaultFeedName(url),
    url,
    category: 'Uncategorized',
    status: 'Pending sync',
    lastSyncedAt: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  }

  await db.insert(feed).values(row)

  return row
}

export async function updateFeedForUser(
  feedId: string,
  userId: string,
  values: { name?: string; category?: string },
) {
  const name = values.name?.trim()
  const category = values.category?.trim()
  if (!name && !category) return

  await db
    .update(feed)
    .set({ ...(name ? { name } : {}), ...(category ? { category } : {}), updatedAt: new Date() })
    .where(and(eq(feed.id, feedId), eq(feed.userId, userId)))
}

export async function deleteFeedForUser(feedId: string, userId: string) {
  await db.delete(article).where(and(eq(article.feedId, feedId), eq(article.userId, userId)))
  await db.delete(feed).where(and(eq(feed.id, feedId), eq(feed.userId, userId)))
}

/** Fetches a feed, stores new articles, then embeds and clusters each new row. */
export async function refreshFeedForUser(feedId: string, userId: string) {
  const rows = await db
    .select()
    .from(feed)
    .where(and(eq(feed.id, feedId), eq(feed.userId, userId)))
    .limit(1)

  const current = rows[0]
  if (!current) throw new Error('Feed not found')

  try {
    const result = await fetchFeed(current.url)
    const now = new Date()

    for (const item of result.items.slice(0, MAX_ITEMS_PER_SYNC)) {
      const inserted = await db
        .insert(article)
        .values({
          id: crypto.randomUUID(),
          feedId: current.id,
          userId,
          title: item.title.slice(0, TITLE_LIMIT),
          url: item.url.slice(0, URL_LIMIT),
          summary: item.summary.slice(0, SUMMARY_LIMIT) || null,
          author: item.author.slice(0, AUTHOR_LIMIT) || null,
          publishedAt: item.publishedAt,
          guid: item.guid.slice(0, GUID_LIMIT) || null,
        })
        .onConflictDoNothing({ target: [article.feedId, article.url] })
        .returning({ id: article.id, title: article.title, summary: article.summary })

      const created = inserted[0]
      if (!created) continue

      try {
        const [embedding] = await generateArticleEmbeddings([created])
        await assignArticleToCluster(created, userId, embedding)
      } catch (error) {
        console.error(
          '[newsroom] Article embedding failed:',
          created.id,
          errorMessage(error, 'Unknown embedding error'),
        )
      }
    }

    const nextName =
      current.name === defaultFeedName(current.url) ? result.title.slice(0, 200) : current.name

    await db
      .update(feed)
      .set({
        name: nextName,
        status: 'Healthy',
        lastSyncedAt: now,
        lastError: null,
        updatedAt: now,
      })
      .where(and(eq(feed.id, feedId), eq(feed.userId, userId)))
  } catch (error) {
    const message = errorMessage(error, 'Unable to refresh feed')

    await db
      .update(feed)
      .set({ status: 'Error', lastError: message.slice(0, 500), updatedAt: new Date() })
      .where(and(eq(feed.id, feedId), eq(feed.userId, userId)))

    throw new Error(message)
  }
}

/**
 * Refreshes feeds sequentially. Clustering mutates shared cluster centroids, so
 * parallel refreshes raced and produced duplicate clusters.
 */
export async function refreshAllFeedsForUser(userId: string): Promise<RefreshResult> {
  const rows = await db
    .select({ id: feed.id, name: feed.name })
    .from(feed)
    .where(eq(feed.userId, userId))

  const errors: string[] = []
  let refreshed = 0

  for (const row of rows) {
    try {
      await refreshFeedForUser(row.id, userId)
      refreshed += 1
    } catch (error) {
      errors.push(`${row.name}: ${errorMessage(error, 'Unable to refresh feed')}`)
    }
  }

  return { refreshed, total: rows.length, errors }
}

/** Rebuilds all clusters. Embeddings are computed before anything is deleted. */
export async function reclusterArticlesForUser(userId: string): Promise<ReclusterResult> {
  const rows = await db
    .select({ id: article.id, title: article.title, summary: article.summary })
    .from(article)
    .where(eq(article.userId, userId))

  if (rows.length === 0) return { processed: 0, total: 0, errors: [] }

  const embeddings: number[][] = []
  const errors: string[] = []

  for (let start = 0; start < rows.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = rows.slice(start, start + EMBEDDING_BATCH_SIZE)

    try {
      embeddings.push(...(await generateArticleEmbeddings(batch)))
    } catch (error) {
      errors.push(
        `Batch ${start + 1}-${start + batch.length}: ${errorMessage(
          error,
          'Embedding request failed',
        )}`,
      )
      break
    }
  }

  if (errors.length > 0 || embeddings.length !== rows.length) {
    return {
      processed: 0,
      total: rows.length,
      errors: [...errors, 'Existing persisted embeddings and clusters were preserved.'],
    }
  }

  await db.delete(cluster).where(eq(cluster.userId, userId))
  await db.update(article).set({ clusterId: null }).where(eq(article.userId, userId))

  let processed = 0

  for (const [index, item] of rows.entries()) {
    try {
      await assignArticleToCluster(item, userId, embeddings[index])
      processed += 1
    } catch (error) {
      const message = errorMessage(error, 'Unknown clustering error')
      errors.push(`${item.title.slice(0, 80)}: ${message}`)
      console.error('[newsroom] Article clustering failed:', item.id, message)
    }
  }

  return { processed, total: rows.length, errors }
}

export async function refreshAndClusterAllForUser(userId: string) {
  const feeds = await refreshAllFeedsForUser(userId)
  const articles = await reclusterArticlesForUser(userId)

  // Namespaced: both results carry a `total`, which previously collided when
  // the two objects were spread into one.
  return { feeds, articles }
}
