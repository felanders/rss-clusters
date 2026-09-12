import { openRouterEmbeddings } from '@/lib/openrouter'

/**
 * Embeddings for "headline + short summary". Two providers:
 *  - openrouter (default): EMBEDDING_PROVIDER=openrouter, OPENROUTER_EMBEDDING_MODEL (default baai/bge-m3 — multilingual, cheap, cleanly separates same-story pairs)
 *  - local: EMBEDDING_PROVIDER=local, runs in-process through @huggingface/transformers (install it separately: `pnpm add @huggingface/transformers`),
 *    LOCAL_EMBEDDING_MODEL (default Xenova/multilingual-e5-small)
 */
export const EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER === 'local' ? 'local' : 'openrouter'
export const EMBEDDING_MODEL = EMBEDDING_PROVIDER === 'local' ? (process.env.LOCAL_EMBEDDING_MODEL ?? 'Xenova/multilingual-e5-small') : (process.env.OPENROUTER_EMBEDDING_MODEL ?? 'baai/bge-m3')
/** Stored next to each vector so a provider/model change invalidates old embeddings instead of mixing vector spaces. */
export const EMBEDDING_MODEL_ID = `${EMBEDDING_PROVIDER}:${EMBEDDING_MODEL}`

const SUMMARY_CHARS = 500

export function stripHtml(value: string) {
  return value.replace(/<[^>]+>/g, ' ').replace(/&(nbsp|#160);/g, ' ').replace(/&(amp);/g, '&').replace(/&(quot|#34);/g, '"').replace(/&(#39|apos);/g, "'").replace(/&(lt);/g, '<').replace(/&(gt);/g, '>').replace(/&#x?[0-9a-f]+;|&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim()
}

export function articleEmbeddingText(item: { title: string; summary: string | null }) {
  const summary = stripHtml(item.summary ?? '').slice(0, SUMMARY_CHARS)
  const prefix = /e5/i.test(EMBEDDING_MODEL) ? 'query: ' : ''
  return `${prefix}${stripHtml(item.title)}${summary ? `\n${summary}` : ''}`
}

export function cosineSimilarity(left: number[], right: number[]) {
  if (left.length !== right.length || left.length === 0) return 0
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]
    leftMagnitude += left[index] * left[index]
    rightMagnitude += right[index] * right[index]
  }
  const denominator = Math.sqrt(leftMagnitude * rightMagnitude)
  return denominator === 0 ? 0 : dot / denominator
}

export function meanVector(vectors: number[][]) {
  const mean = new Array<number>(vectors[0]?.length ?? 0).fill(0)
  for (const vector of vectors) for (let index = 0; index < mean.length; index += 1) mean[index] += vector[index] / vectors.length
  return mean
}

type FeatureExtractor = (texts: string[], options: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>
let localExtractor: Promise<FeatureExtractor> | undefined

async function embedLocally(texts: string[]) {
  localExtractor ??= (async () => {
    // Loaded by name at runtime so the (large, native) package is only required when the local provider is enabled.
    const load = new Function('name', 'return import(name)') as (name: string) => Promise<{ pipeline: (task: string, model: string) => Promise<FeatureExtractor> }>
    const { pipeline } = await load('@huggingface/transformers').catch(() => { throw new Error('EMBEDDING_PROVIDER=local needs @huggingface/transformers — run `pnpm add @huggingface/transformers`') })
    return pipeline('feature-extraction', EMBEDDING_MODEL)
  })()
  const extractor = await localExtractor
  const output = await extractor(texts, { pooling: 'mean', normalize: true })
  return output.tolist()
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return []
  return EMBEDDING_PROVIDER === 'local' ? embedLocally(texts) : openRouterEmbeddings(EMBEDDING_MODEL, texts)
}
