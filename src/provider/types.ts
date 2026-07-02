import type { TurnRequest, TurnResult } from '../types.js'

/** Streamed during a single turn: text deltas, then exactly one `done`. */
export type ProviderStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'done'; result: TurnResult }

/**
 * The seam that makes the harness model-agnostic. The loop never imports an
 * SDK — it only drives an `LLMProvider`. Ship one implementation (Anthropic);
 * adding another (OpenAI, a local model, a mock for tests) is additive.
 */
export interface LLMProvider {
  streamTurn(req: TurnRequest): AsyncIterable<ProviderStreamEvent>
}
