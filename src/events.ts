import type { StopReason } from './types.js'

/** Running totals reported on `usage` and `done` events. */
export interface UsageTotals {
  /** Uncached input tokens (full rate). */
  inputTokens: number
  outputTokens: number
  /** Tokens served from the prompt cache (~0.1x). */
  cacheReadTokens: number
  /** Tokens written to the prompt cache (~1.25x). */
  cacheCreationTokens: number
  costUSD: number
}

/**
 * The event stream `runAgent` yields. Consume it with `for await`.
 * A run always ends with exactly one `done` or one `error` event.
 */
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; name: string; content: string; isError: boolean }
  | { type: 'usage'; turn: number } & UsageTotals
  | {
      type: 'done'
      /** Why the run ended — a model stop reason or a guardrail. */
      reason: StopReason | 'max_turns' | 'max_cost'
      finalText: string
      turns: number
      usage: UsageTotals
    }
  | { type: 'error'; message: string }
