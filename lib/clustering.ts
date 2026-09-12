import { and, eq, gt, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { article, cluster, feed } from '@/lib/db/schema'
import { EMBEDDING_MODEL_ID, articleEmbeddingText, cosineSimilarity, embedTexts, meanVector, stripHtml } from '@/lib/embeddings'
import { openRouterJson } from '@/lib/openrouter'

/**
 * Pipeline (per user):
 *  1. embedPendingArticles  — embed "headline + summary" of every article that has no embedding for the current model (called right after feeds are fetched).
 *  2. clusterPendingArticles — for every not-yet-clustered article find its nearest neighbours (cosine, time-gated), join them into candidate groups
 *     (connected components), and let an LLM split each candidate group into clusters of articles that report the *same* story. Only LLM-confirmed
 *     groups of ≥2 articles become clusters; the LLM also writes the neutral headline and summary. Everything else stays a singleton.
 *  3. reclusterAll — throw away all cluster assignments and run 1+2 over the whole archive.
 */

const CLUSTER_MODEL = process.env.OPENROUTER_CLUSTER_MODEL ?? process.env.OPENROUTER_CLUSTER_VERIFICATION_MODEL ?? 'google/gemini-3.5-flash-lite'
const OUTPUT_LANGUAGE = process.env.CLUSTER_OUTPUT_LANGUAGE ?? 'English'
/** Minimum cosine similarity for two articles to be considered neighbours (candidates — the LLM has the final say). */
const NEIGHBOR_THRESHOLD = numberEnv(process.env.CLUSTER_NEIGHBOR_THRESHOLD ?? process.env.LOCAL_CLUSTER_THRESHOLD, 0.6)
/** Neighbours kept per article. */
const NEIGHBOR_K = numberEnv(process.env.CLUSTER_NEIGHBOR_K, 8)
/** Recent articles that new arrivals are compared against. */
const WINDOW_HOURS = numberEnv(process.env.CLUSTER_WINDOW_HOURS, 96)
/** Two articles must be published within this gap to be neighbours — the same story breaks in every outlet within a day or two. */
const MAX_TIME_GAP_HOURS = numberEnv(process.env.CLUSTER_MAX_TIME_GAP_HOURS, 48)
/** Largest candidate group sent to the LLM in one request. */
const MAX_GROUP_SIZE = numberEnv(process.env.CLUSTER_MAX_GROUP_SIZE, 20)
const LLM_CONCURRENCY = 3
const EMBED_BATCH = 32

function numberEnv(value: string | undefined, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && value !== undefined && value !== '' ? parsed : fallback
}

export type Log = (message: string) => void
const silent: Log = () => {}

export type ClusterRunResult = { candidates: number; groupsProposed: number; clustersConfirmed: number; articlesClustered: number; errors: string[] }

type PoolItem = {
  id: string
  title: string
  summary: string | null
  publishedAt: Date | null
  createdAt: Date
  feedName: string
  clusterId: string | null
  clusteredAt: Date | null
  embedding: number[] | null
}

export async function embedPendingArticles(userId: string, log: Log = silent) {
  const pending = await db.select({ id: article.id, title: article.title, summary: article.summary }).from(article)
    .where(and(eq(article.userId, userId), or(isNull(article.embedding), isNull(article.embeddingModel), ne(article.embeddingModel, EMBEDDING_MODEL_ID))))
  const errors: string[] = []
  let embedded = 0
  if (pending.length) log(`Embedding ${pending.length} article${pending.length === 1 ? '' : 's'} with ${EMBEDDING_MODEL_ID}…`)
  for (let start = 0; start < pending.length; start += EMBED_BATCH) {
    const batch = pending.slice(start, start + EMBED_BATCH)
    try {
      const vectors = await embedTexts(batch.map(articleEmbeddingText))
      for (const [index, item] of batch.entries()) {
        await db.update(article).set({ embedding: vectors[index], embeddingModel: EMBEDDING_MODEL_ID }).where(eq(article.id, item.id))
      }
      embedded += batch.length
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Embedding failed'
      errors.push(`Embedding batch ${start + 1}-${start + batch.length}: ${message}`)
      log(`Embedding failed for articles ${start + 1}-${start + batch.length}: ${message}`)
      if (/quota|credits|401|403/i.test(message)) break
    }
  }
  return { embedded, pending: pending.length, errors }
}

function poolQuery(userId: string) {
  return db.select({
    id: article.id, title: article.title, summary: article.summary, publishedAt: article.publishedAt, createdAt: article.createdAt,
    feedName: sql<string>`coalesce(${feed.name}, 'Unknown source')`, clusterId: article.clusterId, clusteredAt: article.clusteredAt, embedding: article.embedding,
  }).from(article).leftJoin(feed, eq(feed.id, article.feedId))
}

/** Cluster every article that has not been through the pipeline yet, against the recent pool. */
export async function clusterPendingArticles(userId: string, log: Log = silent): Promise<ClusterRunResult> {
  const since = new Date(Date.now() - WINDOW_HOURS * 3_600_000)
  const pool = await poolQuery(userId).where(and(
    eq(article.userId, userId), isNotNull(article.embedding), eq(article.embeddingModel, EMBEDDING_MODEL_ID),
    or(isNull(article.clusteredAt), gt(sql`coalesce(${article.publishedAt}, ${article.createdAt})`, since)),
  ))
  return runClustering(userId, pool, log)
}

/** Drop all clusters for the user and rebuild them from scratch over the whole archive. */
export async function reclusterAll(userId: string, log: Log = silent): Promise<ClusterRunResult & { embedded: number }> {
  const embedding = await embedPendingArticles(userId, log)
  if (embedding.errors.length && embedding.embedded === 0 && embedding.pending > 0) {
    return { candidates: 0, groupsProposed: 0, clustersConfirmed: 0, articlesClustered: 0, errors: embedding.errors, embedded: 0 }
  }
  log('Resetting existing clusters…')
  await db.update(article).set({ clusterId: null, clusteredAt: null }).where(eq(article.userId, userId))
  await db.delete(cluster).where(eq(cluster.userId, userId))
  const pool = await poolQuery(userId).where(and(eq(article.userId, userId), isNotNull(article.embedding), eq(article.embeddingModel, EMBEDDING_MODEL_ID)))
  const result = await runClustering(userId, pool, log)
  return { ...result, errors: [...embedding.errors, ...result.errors], embedded: embedding.embedded }
}

function publishedTime(item: PoolItem) { return (item.publishedAt ?? item.createdAt).getTime() }

/** Nearest-neighbour search + union-find: returns candidate groups (each containing at least one pending article). */
function candidateGroups(items: PoolItem[]) {
  const parent = items.map((_, index) => index)
  const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]))
  const union = (left: number, right: number) => { parent[find(left)] = find(right) }
  const maxGap = MAX_TIME_GAP_HOURS * 3_600_000
  for (const [index, item] of items.entries()) {
    if (item.clusteredAt) continue
    const neighbours: Array<{ index: number; score: number }> = []
    for (const [otherIndex, other] of items.entries()) {
      if (otherIndex === index || Math.abs(publishedTime(item) - publishedTime(other)) > maxGap) continue
      const score = cosineSimilarity(item.embedding!, other.embedding!)
      if (score >= NEIGHBOR_THRESHOLD) neighbours.push({ index: otherIndex, score })
    }
    neighbours.sort((left, right) => right.score - left.score)
    for (const neighbour of neighbours.slice(0, NEIGHBOR_K)) union(index, neighbour.index)
  }
  const groups = new Map<number, PoolItem[]>()
  for (const [index, item] of items.entries()) {
    const root = find(index)
    groups.set(root, [...(groups.get(root) ?? []), item])
  }
  return [...groups.values()].filter((group) => group.some((item) => !item.clusteredAt))
}

const proposalSchema = z.object({
  clusters: z.array(z.object({
    article_ids: z.array(z.coerce.number().int()).min(1),
    headline: z.string().min(1),
    summary: z.array(z.string().min(1)).min(1).max(4),
  })),
})
type Proposal = z.infer<typeof proposalSchema>['clusters'][number]

function formatDate(date: Date) { return date.toISOString().slice(0, 16).replace('T', ' ') }

/** Ask the LLM to partition one candidate group into clusters of articles reporting the same story. */
async function proposeClusters(items: PoolItem[]): Promise<Proposal[]> {
  const existing = new Map<string, number[]>()
  for (const [index, item] of items.entries()) if (item.clusterId) existing.set(item.clusterId, [...(existing.get(item.clusterId) ?? []), index + 1])
  const existingNote = existing.size ? `\nSome articles are already grouped together from an earlier pass; keep them together unless they clearly describe different stories:\n${[...existing.values()].map((ids) => `- articles ${ids.join(', ')}`).join('\n')}\n` : ''
  const listing = items.map((item, index) => `[${index + 1}] (${item.feedName}, ${formatDate(item.publishedAt ?? item.createdAt)}) ${stripHtml(item.title)}\n    ${stripHtml(item.summary ?? '').slice(0, 400) || '(no summary)'}`).join('\n\n')
  const prompt = `You are a careful news editor. Below are articles that an embedding search found similar. Decide which of them report the SAME news story.

Rules:
- Two articles belong together only if they report the same specific event or development (same who, what, where and when). Reports on the same event from different outlets, languages or angles belong together.
- Articles that merely share a topic, region, person, organisation or theme but describe different events do NOT belong together. When in doubt, keep them apart.
- Each article may appear in at most one cluster. Only list clusters with two or more articles; leave unmatched articles out entirely.
- For each cluster write a new headline: neutral, direct and factual, present tense, no clickbait, no outlet names, at most 14 words, written in ${OUTPUT_LANGUAGE}.
- Also write 2-3 short bullet points in ${OUTPUT_LANGUAGE} summarising the key facts reported across the articles. Do not invent facts that are not in the articles.
${existingNote}
Respond with JSON only, in this shape:
{"clusters":[{"article_ids":[1,2],"headline":"...","summary":["...","..."]}]}
If nothing belongs together respond with {"clusters":[]}.

Articles:

${listing}`
  const result = await openRouterJson(CLUSTER_MODEL, [{ role: 'user', content: prompt }], proposalSchema)
  return result.clusters
}

function chunk<T>(list: T[], size: number) {
  const chunks: T[][] = []
  for (let start = 0; start < list.length; start += size) chunks.push(list.slice(start, start + size))
  return chunks
}

async function runClustering(userId: string, pool: PoolItem[], log: Log): Promise<ClusterRunResult> {
  const dimension = pool.find((item) => item.embedding?.length)?.embedding?.length ?? 0
  const items = pool.filter((item) => item.embedding?.length === dimension)
  const candidates = items.filter((item) => !item.clusteredAt)
  const result: ClusterRunResult = { candidates: candidates.length, groupsProposed: 0, clustersConfirmed: 0, articlesClustered: 0, errors: [] }
  if (candidates.length === 0) { log('No new articles to cluster.'); return result }
  log(`Searching nearest neighbours for ${candidates.length} new article${candidates.length === 1 ? '' : 's'} among ${items.length} recent ones (threshold ${NEIGHBOR_THRESHOLD})…`)

  const groups = candidateGroups(items)
  const singles = groups.filter((group) => group.length === 1).flat()
  const batches = groups.filter((group) => group.length > 1).flatMap((group) => chunk([...group].sort((left, right) => publishedTime(right) - publishedTime(left)), MAX_GROUP_SIZE))
  result.groupsProposed = batches.length
  if (singles.length) await markClustered(singles.map((item) => item.id))
  log(`${singles.length} article${singles.length === 1 ? ' has' : 's have'} no close neighbour; ${batches.length} candidate group${batches.length === 1 ? '' : 's'} go to ${CLUSTER_MODEL} for verification…`)

  const touched = new Set<string>()
  for (const batchGroup of chunk(batches, LLM_CONCURRENCY)) {
    const proposals = await Promise.all(batchGroup.map(async (group) => {
      try {
        return await proposeClusters(group)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'LLM request failed'
        result.errors.push(`Group of ${group.length} (${stripHtml(group[0].title).slice(0, 60)}…): ${message}`)
        log(`LLM verification failed: ${message}`)
        return null
      }
    }))
    for (const [index, proposal] of proposals.entries()) {
      // A failed group stays pending so the next run retries it.
      if (!proposal) continue
      const applied = await applyProposals(userId, batchGroup[index], proposal, touched)
      result.clustersConfirmed += applied.clusters
      result.articlesClustered += applied.articles
      for (const confirmed of applied.headlines) log(`Cluster: ${confirmed}`)
    }
  }
  await reconcileClusters(userId)
  log(`Done: ${result.clustersConfirmed} cluster${result.clustersConfirmed === 1 ? '' : 's'} confirmed covering ${result.articlesClustered} articles.`)
  return result
}

async function markClustered(ids: string[]) {
  if (ids.length) await db.update(article).set({ clusteredAt: new Date() }).where(inArray(article.id, ids))
}

async function applyProposals(userId: string, group: PoolItem[], proposals: Proposal[], touched: Set<string>) {
  const now = new Date()
  const assigned = new Set<string>()
  const headlines: string[] = []
  let clusters = 0
  let articles = 0
  for (const proposal of proposals) {
    const members = [...new Set(proposal.article_ids)].map((number) => group[number - 1]).filter((item): item is PoolItem => Boolean(item) && !assigned.has(item.id))
    if (members.length < 2) continue
    members.forEach((item) => assigned.add(item.id))
    // Reuse the cluster most of the members already belong to so its id (and read state) stays stable; otherwise start a new one.
    const votes = new Map<string, number>()
    for (const item of members) if (item.clusterId) votes.set(item.clusterId, (votes.get(item.clusterId) ?? 0) + 1)
    const existingId = [...votes.entries()].sort((left, right) => right[1] - left[1])[0]?.[0]
    const clusterId = existingId ?? crypto.randomUUID()
    const values = { canonicalTitle: proposal.headline.trim().slice(0, 500), summary: proposal.summary.map((line) => line.trim().slice(0, 500)), centroid: meanVector(members.map((item) => item.embedding!)), articleCount: members.length, lastUpdatedAt: now }
    if (existingId) await db.update(cluster).set(values).where(and(eq(cluster.id, existingId), eq(cluster.userId, userId)))
    else await db.insert(cluster).values({ id: clusterId, userId, createdAt: now, ...values })
    for (const item of members) { if (item.clusterId) touched.add(item.clusterId); item.clusterId = clusterId; item.clusteredAt = now }
    touched.add(clusterId)
    await db.update(article).set({ clusterId, clusteredAt: now }).where(and(eq(article.userId, userId), inArray(article.id, members.map((item) => item.id))))
    headlines.push(`${values.canonicalTitle} (${members.length} articles)`)
    clusters += 1
    articles += members.length
  }
  // Pending articles the LLM left out are singletons for now (a later arrival can still pull them into a cluster).
  const leftovers = group.filter((item) => !item.clusteredAt && !assigned.has(item.id))
  await markClustered(leftovers.map((item) => item.id))
  leftovers.forEach((item) => { item.clusteredAt = now })
  return { clusters, articles, headlines }
}

/** Recount cluster sizes from the articles table and dissolve anything that no longer has two members. */
export async function reconcileClusters(userId: string) {
  await db.execute(sql`update ${cluster} c set "articleCount" = (select count(*) from ${article} a where a."clusterId" = c.id) where c."userId" = ${userId}`)
  const orphaned = await db.select({ id: cluster.id }).from(cluster).where(and(eq(cluster.userId, userId), sql`${cluster.articleCount} < 2`))
  if (orphaned.length === 0) return
  const ids = orphaned.map((row) => row.id)
  await db.update(article).set({ clusterId: null }).where(and(eq(article.userId, userId), inArray(article.clusterId, ids)))
  await db.delete(cluster).where(and(eq(cluster.userId, userId), inArray(cluster.id, ids)))
}
