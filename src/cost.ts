/**
 * Per-model pricing (USD per 1M tokens) for cost estimates.
 * Edit or extend this map for models you use. Unknown models cost 0
 * (tracked as tokens only) — add an entry to get dollar figures.
 */
export interface ModelPricing {
  inputPerMTok: number
  outputPerMTok: number
}

export const PRICING: Record<string, ModelPricing> = {
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25 },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 }
}

/** Cache-read tokens bill at ~0.1x the input rate. */
const CACHE_READ_MULTIPLIER = 0.1
/** Cache-write tokens bill at ~1.25x the input rate (5-minute TTL). */
const CACHE_WRITE_MULTIPLIER = 1.25

/**
 * Estimated USD cost for a token count on a given model.
 *
 * `inputTokens` is the *uncached* remainder; cache-read and cache-write tokens
 * are separate fields that bill at reduced / premium rates respectively.
 */
export function costUSD(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheCreationTokens = 0
): number {
  const p = PRICING[model]
  if (!p) return 0
  const inputCost =
    (inputTokens +
      cacheReadTokens * CACHE_READ_MULTIPLIER +
      cacheCreationTokens * CACHE_WRITE_MULTIPLIER) *
    p.inputPerMTok
  const outputCost = outputTokens * p.outputPerMTok
  return (inputCost + outputCost) / 1_000_000
}
