'use server'

import { revalidatePath } from 'next/cache'
import { requireUserId } from '@/lib/auth-session'
import {
  createFeedForUser,
  deleteFeedForUser,
  listArticlesForUser,
  listClustersForUser,
  listFeedsForUser,
  listReadArticleIdsForUser,
  markArticleReadForUser,
  reclusterArticlesForUser,
  refreshAllFeedsForUser,
  refreshAndClusterAllForUser,
  refreshFeedForUser,
  updateFeedForUser,
} from '@/lib/feeds/service'

/**
 * Thin session-scoped wrappers around lib/feeds/service.
 * Every export here is a public endpoint, so none of them accept a user id.
 * Scheduled runs call the service functions directly from the cron route.
 */

export async function listFeeds() {
  return listFeedsForUser(await requireUserId())
}

export async function listArticles() {
  return listArticlesForUser(await requireUserId())
}

export async function listClusters() {
  return listClustersForUser(await requireUserId())
}

export async function listReadArticleIds() {
  return listReadArticleIdsForUser(await requireUserId())
}

export async function markArticleRead(articleId: string) {
  await markArticleReadForUser(articleId, await requireUserId())
  revalidatePath('/')
}

export async function addFeed(rawUrl: string) {
  const userId = await requireUserId()
  const row = await createFeedForUser(rawUrl, userId)

  try {
    await refreshFeedForUser(row.id, userId)
  } catch {
    // Keep the feed row with its error status so the user can retry.
  }

  revalidatePath('/')
  return row
}

export async function updateFeed(feedId: string, values: { name?: string; category?: string }) {
  await updateFeedForUser(feedId, await requireUserId(), values)
  revalidatePath('/')
}

export async function deleteFeed(feedId: string) {
  await deleteFeedForUser(feedId, await requireUserId())
  revalidatePath('/')
}

export async function refreshFeed(feedId: string) {
  const userId = await requireUserId()

  try {
    await refreshFeedForUser(feedId, userId)
  } finally {
    // Runs on the error path too, so the feed's Error status reaches the UI.
    revalidatePath('/')
  }
}

export async function refreshAllFeeds() {
  const result = await refreshAllFeedsForUser(await requireUserId())
  revalidatePath('/')
  return result
}

export async function reclusterArticles() {
  const result = await reclusterArticlesForUser(await requireUserId())
  revalidatePath('/')
  return result
}

export async function refreshAndClusterAll() {
  const result = await refreshAndClusterAllForUser(await requireUserId())
  revalidatePath('/')
  return result
}
