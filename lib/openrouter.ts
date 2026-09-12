import type { z } from 'zod'

const API_URL = (process.env.OPENROUTER_API_URL ?? 'https://openrouter.ai/api/v1/').replace(/\/?$/, '/')
const CONNECTOR = process.env.OPENROUTER_CONNECTOR_UID ?? 'openrouter.ai/clustered-rss-feeds-openrouter'
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504])

export class OpenRouterError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}

/** Prefer a plain API key; fall back to the Vercel Connect integration the deployment was created with. */
async function token() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY
  try {
    const { getToken } = await import('@vercel/connect')
    return await getToken(CONNECTOR, { subject: { type: 'app' } })
  } catch (error) {
    throw new OpenRouterError(`No OpenRouter credentials: set OPENROUTER_API_KEY (Vercel Connect fallback failed: ${error instanceof Error ? error.message : error})`)
  }
}

async function post<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  const key = await token()
  let lastError: OpenRouterError | undefined
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(new URL(path, API_URL), {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://github.com/felanders/rss-clusters', 'X-Title': 'Clustered RSS Feeds' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.ok) return response.json() as Promise<T>
    const detail = (await response.text()).slice(0, 300)
    lastError = new OpenRouterError(`OpenRouter ${path} failed (${response.status}): ${detail}`, response.status)
    // Daily quotas on free models don't recover within a retry window — fail fast so callers can report it.
    if (!RETRYABLE.has(response.status) || detail.includes('free-models-per-day')) throw lastError
    await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)))
  }
  throw lastError ?? new OpenRouterError(`OpenRouter ${path} failed`)
}

export async function openRouterEmbeddings(model: string, input: string[]): Promise<number[][]> {
  const payload = await post<{ data?: Array<{ index?: number; embedding?: number[] }> }>('embeddings', { model, input }, 60_000)
  const vectors = [...(payload.data ?? [])].sort((left, right) => (left.index ?? 0) - (right.index ?? 0)).map((item) => item.embedding)
  if (vectors.length !== input.length || vectors.some((vector) => !vector?.length || vector.some((value) => !Number.isFinite(value)))) throw new OpenRouterError('Embedding response was invalid')
  return vectors as number[][]
}

function extractJson(content: string) {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (fenced ? fenced[1] : content).trim()
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  return start >= 0 && end > start ? candidate.slice(start, end + 1) : candidate
}

/** Chat completion that must come back as a JSON object matching `schema`. One re-ask on malformed output. */
export async function openRouterJson<T>(model: string, messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>, schema: z.ZodType<T>): Promise<T> {
  let conversation = messages
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const payload = await post<{ choices?: Array<{ message?: { content?: string } }> }>('chat/completions', { model, temperature: 0.1, messages: conversation, response_format: { type: 'json_object' } }, 90_000)
    const content = payload.choices?.[0]?.message?.content
    if (!content) throw new OpenRouterError('Model returned no content')
    try {
      return schema.parse(JSON.parse(extractJson(content)))
    } catch (error) {
      lastError = error
      conversation = [...messages, { role: 'assistant', content }, { role: 'user', content: `That was not valid JSON matching the required shape (${error instanceof Error ? error.message.slice(0, 200) : 'parse error'}). Respond again with only the JSON object.` }]
    }
  }
  throw new OpenRouterError(`Model output could not be parsed: ${lastError instanceof Error ? lastError.message.slice(0, 200) : 'unknown'}`)
}
