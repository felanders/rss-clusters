import type { ChatResult } from '@openrouter/sdk/models'
import type { z } from 'zod'
import {
  CLUSTER_VERIFICATION_MODEL,
  devError,
  devLog,
  openRouterClient,
} from './openrouter'

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
    const openrouter = await openRouterClient()
    const response = await openrouter.chat.send(
      {
        chatRequest: {
          model: CLUSTER_VERIFICATION_MODEL,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          stream: false,
        },
      },
      { timeoutMs: CLUSTER_MODEL_TIMEOUT_MS },
    )

    const result = response as ChatResult
    const content = result.choices[0]?.message?.content
    if (typeof content !== 'string') {
      throw new Error('Cluster model returned no text content')
    }

    const parsed = schema.parse(JSON.parse(content))
    devLog('Cluster model response parsed', parsed)
    return parsed
  } catch (error) {
    devError('Cluster model request failed', error)
    throw error
  }
}
