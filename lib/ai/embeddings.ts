import { devError, devLog } from './openrouter'

/**
 * OpenRouter has no embeddings endpoint, so embeddings use a separate
 * OpenAI-compatible provider. Implemented with plain `fetch` to avoid adding a
 * provider dependency.
 */
const EMBEDDINGS_API_URL = process.env.EMBEDDINGS_API_URL ?? 'https://api.openai.com/v1'
const EMBEDDINGS_MODEL = process.env.EMBEDDINGS_MODEL ?? 'text-embedding-3-small'

const EMBEDDING_TIMEOUT_MS = 60_000
const SUMMARY_CHAR_LIMIT = 1_200

export type EmbeddingInput = { title: string; summary: string | null }

type EmbeddingsResponse = {
  data?: Array<{ index?: number; embedding?: number[] }>
  error?: { message?: string }
}

function embeddingValue(item: EmbeddingInput) {
  return `${item.title}\n${(item.summary ?? '').slice(0, SUMMARY_CHAR_LIMIT)}`.trim()
}

function isValidEmbedding(embedding: number[] | undefined): embedding is number[] {
  return Boolean(embedding?.length) && embedding!.every((value) => Number.isFinite(value))
}

export async function generateArticleEmbeddings(
  items: readonly EmbeddingInput[],
): Promise<number[][]> {
  if (items.length === 0) return []

  const apiKey = process.env.EMBEDDINGS_API_KEY
  if (!apiKey) throw new Error('EMBEDDINGS_API_KEY is not configured')

  devLog('Embedding request started', { model: EMBEDDINGS_MODEL, articleCount: items.length })

  try {
    const response = await fetch(`${EMBEDDINGS_API_URL}/embeddings`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: EMBEDDINGS_MODEL, input: items.map(embeddingValue) }),
      signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
      cache: 'no-store',
    })

    const payload = (await response.json()) as EmbeddingsResponse

    if (!response.ok) {
      throw new Error(payload.error?.message ?? `Embedding provider returned ${response.status}`)
    }

    const embeddings = [...(payload.data ?? [])]
      .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
      .map((entry) => entry.embedding)

    devLog('Embedding response received', {
      returned: embeddings.length,
      expected: items.length,
      dimensions: embeddings[0]?.length ?? 0,
    })

    if (embeddings.length !== items.length || !embeddings.every(isValidEmbedding)) {
      throw new Error('Embedding response was invalid')
    }

    return embeddings as number[][]
  } catch (error) {
    devError('Embedding request failed', error)
    throw error
  }
}
