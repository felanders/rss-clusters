import { generateObject } from 'ai'
import type { z } from 'zod'
import { CLUSTER_VERIFICATION_MODEL, devError, devLog, openRouterProvider } from './openrouter'

const CLUSTER_MODEL_TIMEOUT_MS = 30_000

/**
 * Calls the cluster reasoning model with a schema-constrained response.
 * `generateObject` replaces `generateText` + `JSON.parse`, which broke whenever
 * the model wrapped its JSON in prose or a code fence.
 */
export async function callClusterModel<T>(prompt: string, schema: z.ZodType<T>): Promise<T> {
  devLog('Cluster model request started', {
    model: CLUSTER_VERIFICATION_MODEL,
    promptLength: prompt.length,
  })

  try {
    const openrouter = await openRouterProvider()

    const { object } = await generateObject({
      model: openrouter(CLUSTER_VERIFICATION_MODEL),
      schema,
      prompt,
      temperature: 0.1,
      abortSignal: AbortSignal.timeout(CLUSTER_MODEL_TIMEOUT_MS),
    })

    devLog('Cluster model response parsed', object)
    return object
  } catch (error) {
    devError('Cluster model request failed', error)
    throw error
  }
}
