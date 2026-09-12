import {
  devError,
  devLog,
  openRouterClient,
} from './openrouter'

const EMBEDDINGS_MODEL = process.env.OPENROUTER_EMBEDDING_MODEL ?? 'sentence-transformers/all-minilm-l12-v2'

const SUMMARY_CHAR_LIMIT = 1_200

export type EmbeddingInput = { title: string; summary: string | null }

function embeddingValue(item: EmbeddingInput) {
  return `${item.title}\n${(item.summary ?? '').slice(0, SUMMARY_CHAR_LIMIT)}`.trim()
}

function isValidEmbedding(embedding: string | number[]): embedding is number[] {
  return Array.isArray(embedding) && embedding.length > 0 && embedding.every((value) => Number.isFinite(value))
}

export async function generateArticleEmbeddings(
  items: readonly EmbeddingInput[],
): Promise<number[][]> {
  if (items.length === 0) return []

  const apiKey = process.env.EMBEDDINGS_API_KEY
  if (!apiKey) throw new Error('EMBEDDINGS_API_KEY is not configured')

  devLog('Embedding request started', { model: EMBEDDINGS_MODEL, articleCount: items.length })

  try {
    const openrouter = await openRouterClient()
    const response = await openrouter.embeddings.generate({
      requestBody: {
        model: EMBEDDINGS_MODEL,
        input: items.map(embeddingValue),
        encodingFormat: 'float',
      },
    })

    if (typeof response === 'string' || !('data' in response)) {
      throw new Error('Embedding response did not contain vector data')
    }

    const embeddings = [...response.data]
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
