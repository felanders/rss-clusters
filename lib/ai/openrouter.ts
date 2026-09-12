import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { getToken } from '@vercel/connect'

export const CLUSTER_VERIFICATION_MODEL =
  process.env.OPENROUTER_CLUSTER_VERIFICATION_MODEL ?? 'google/gemini-2.5-flash-lite'

const OPENROUTER_API_URL = process.env.OPENROUTER_API_URL ?? 'https://openrouter.ai/api/v1'

function requireEnv(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

/**
 * Resolves a short-lived OpenRouter credential through Vercel Connect.
 * Validated lazily so a missing env var cannot break the module import.
 */
export async function openRouterProvider() {
  const connector = requireEnv(process.env.OPENROUTER_CONNECTOR_UID, 'OPENROUTER_CONNECTOR_UID')
  const apiKey = await getToken(connector, { subject: { type: 'app' } })
  return createOpenRouter({ apiKey, baseURL: OPENROUTER_API_URL })
}

const isDevelopment = process.env.NODE_ENV !== 'production'

export function devLog(message: string, details?: unknown) {
  if (isDevelopment) console.log(`[newsroom] ${message}`, details ?? '')
}

export function devError(message: string, error: unknown) {
  if (isDevelopment) console.error(`[newsroom] ${message}`, error)
}

export function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback
}
