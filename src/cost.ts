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

/** Estimated USD cost for a token count on a given model. */
export function costUSD(model: string, inputTokens: number, outputTokens: number): number {
  const p = PRICING[model]
  if (!p) return 0
  return (inputTokens * p.inputPerMTok + outputTokens * p.outputPerMTok) / 1_000_000
}
