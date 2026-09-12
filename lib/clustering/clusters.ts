import { and, desc, eq, gt } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { article, cluster } from '@/lib/db/schema'
import { callClusterModel } from '@/lib/ai/cluster-model'
import { errorMessage } from '@/lib/ai/openrouter'
import { cosineSimilarity, updatedCentroid } from './vector'

const parsedThreshold = Number(process.env.LOCAL_CLUSTER_THRESHOLD ?? '0.55')

// A malformed env var previously produced NaN, which silently disabled matching.
export const LOCAL_CLUSTER_THRESHOLD = Number.isFinite(parsedThreshold) ? parsedThreshold : 0.55

const ACTIVE_CLUSTER_WINDOW_MS = 36 * 60 * 60 * 1000
const SYNTHESIS_ARTICLE_LIMIT = 20
const VERIFICATION_ARTICLE_LIMIT = 5
const TEXT_COLUMN_LIMIT = 500

export type ClusterCandidate = {
  id: string
  centroid: number[]
  canonicalTitle: string
  articleCount: number
}

export type ClusterableArticle = { id: string; title: string; summary: string | null }

const synthesisSchema = z.object({
  canonical_title: z.string(),
  summary: z.array(z.string()).length(2),
})

const verificationSchema = z.object({ related: z.boolean(), reason: z.string().max(240) })

function asDigest(rows: readonly { title: string; summary: string | null }[]) {
  return rows.map((row) => `Headline: ${row.title}\nSummary: ${row.summary ?? ''}`).join('\n\n')
}

/** Rewrites a multi-article cluster into one canonical headline plus takeaways. */
async function synthesizeCluster(clusterId: string, userId: string) {
  const rows = await db
    .select({ title: article.title, summary: article.summary })
    .from(article)
    .where(and(eq(article.userId, userId), eq(article.clusterId, clusterId)))
    .orderBy(desc(article.publishedAt))
    .limit(SYNTHESIS_ARTICLE_LIMIT)

  if (rows.length < 2) return

  const result = await callClusterModel(
    [
      'You are a neutral news editor. Combine these related headlines and summaries',
      'into one concise canonical headline (max 12 words) and exactly 2 key takeaway bullets.',
      '',
      asDigest(rows),
    ].join('\n'),
    synthesisSchema,
  )

  await db
    .update(cluster)
    .set({
      canonicalTitle: result.canonical_title.slice(0, TEXT_COLUMN_LIMIT),
      summary: result.summary.map((item) => item.slice(0, TEXT_COLUMN_LIMIT)),
      lastUpdatedAt: new Date(),
    })
    .where(and(eq(cluster.id, clusterId), eq(cluster.userId, userId)))
}

/** Second-stage LLM check so topical-but-unrelated articles stay separate. */
async function verifyClusterMatch(
  item: ClusterableArticle,
  candidate: ClusterCandidate,
  score: number,
  userId: string,
) {
  const related = await db
    .select({ title: article.title, summary: article.summary })
    .from(article)
    .where(and(eq(article.userId, userId), eq(article.clusterId, candidate.id)))
    .orderBy(desc(article.publishedAt))
    .limit(VERIFICATION_ARTICLE_LIMIT)

  if (related.length === 0) return false

  const result = await callClusterModel(
    [
      'Decide whether this incoming news article reports the same real-world story as',
      'the existing cluster. Shared topic alone is not enough; require the same event,',
      'people, place, or development. Set related=true only when grouping is',
      'editorially defensible.',
      '',
      'Incoming article:',
      `Headline: ${item.title}`,
      `Summary: ${item.summary ?? ''}`,
      '',
      `Existing cluster (${candidate.articleCount} articles, local similarity ${score.toFixed(3)}):`,
      asDigest(related),
    ].join('\n'),
    verificationSchema,
  )

  return result.related
}

async function bestCandidate(userId: string, embedding: readonly number[]) {
  const activeClusters = await db
    .select({
      id: cluster.id,
      centroid: cluster.centroid,
      canonicalTitle: cluster.canonicalTitle,
      articleCount: cluster.articleCount,
    })
    .from(cluster)
    .where(
      and(
        eq(cluster.userId, userId),
        gt(cluster.lastUpdatedAt, new Date(Date.now() - ACTIVE_CLUSTER_WINDOW_MS)),
      ),
    )

  return activeClusters.reduce<{ candidate: ClusterCandidate | null; score: number }>(
    (best, current) => {
      const score = cosineSimilarity(embedding, current.centroid)
      return score > best.score ? { candidate: current, score } : best
    },
    { candidate: null, score: -1 },
  )
}

export async function assignArticleToCluster(
  item: ClusterableArticle,
  userId: string,
  embedding: number[],
) {
  const { candidate, score } = await bestCandidate(userId, embedding)

  const isLocalMatch = candidate !== null && score >= LOCAL_CLUSTER_THRESHOLD
  const shouldAttach = isLocalMatch && (await verifyClusterMatch(item, candidate, score, userId))

  const now = new Date()
  const clusterId = shouldAttach && candidate ? candidate.id : crypto.randomUUID()
  const articleCount = shouldAttach && candidate ? candidate.articleCount + 1 : 1

  if (shouldAttach && candidate) {
    await db
      .update(cluster)
      .set({
        centroid: updatedCentroid(candidate.centroid, embedding, candidate.articleCount),
        articleCount,
        lastUpdatedAt: now,
      })
      .where(and(eq(cluster.id, clusterId), eq(cluster.userId, userId)))
  } else {
    await db.insert(cluster).values({
      id: clusterId,
      userId,
      centroid: embedding,
      canonicalTitle: item.title.slice(0, TEXT_COLUMN_LIMIT),
      summary: [],
      articleCount,
      lastUpdatedAt: now,
      createdAt: now,
    })
  }

  await db
    .update(article)
    .set({ embedding, clusterId })
    .where(and(eq(article.id, item.id), eq(article.userId, userId)))

  if (articleCount >= 2) {
    try {
      await synthesizeCluster(clusterId, userId)
    } catch (error) {
      console.error(
        '[newsroom] Cluster synthesis failed:',
        clusterId,
        errorMessage(error, 'Unknown synthesis error'),
      )
    }
  }

  return clusterId
}
