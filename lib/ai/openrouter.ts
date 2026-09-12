import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { OpenRouter } from '@openrouter/sdk'
import { getToken } from '@vercel/connect'

export const CLUSTER_VERIFICATION_MODEL =
  process.env.OPENROUTER_CLUSTER_VERIFICATION_MODEL ?? 'google/gemini-3.5-flash-lite'

function requireEnv(value: string | undefined, name: string) {
  if (!value) throw new Error(`${name} is not configured`)
  return value
}

export async function openRouterClient() {
  const connector = requireEnv(process.env.OPENROUTER_CONNECTOR_UID, 'OPENROUTER_CONNECTOR_UID')
  const apiKey = await getToken(connector, { subject: { type: 'app' } })
  return new OpenRouter({apiKey: apiKey })
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
