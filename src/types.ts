/**
 * Core, provider-agnostic types shared across the harness.
 * The loop speaks only these types; provider implementations translate
 * to and from their own SDK shapes.
 */

/** A tool call the model wants to make. */
export interface ToolCall {
  id: string
  name: string
  input: unknown
}

/** The result of executing a tool, fed back to the model. */
export interface ToolResult {
  id: string
  content: string
  isError: boolean
}

/** Normalized tool schema handed to a provider (JSON Schema for inputs). */
export interface ToolSchema {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/**
 * Normalized conversation messages. `assistant.native` carries the provider's
 * own content representation so it can be replayed faithfully on the next turn
 * (this is what preserves thinking blocks / signatures without the loop
 * needing to understand them).
 */
export type ConvMessage =
  | { role: 'user'; text: string }
  | { role: 'tool'; results: ToolResult[] }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[]; native?: unknown }

/** Pass-through thinking configuration (provider-specific shape). */
export type ThinkingConfig =
  | { type: 'adaptive'; display?: 'summarized' | 'omitted' }
  | { type: 'disabled' }
  | { type: 'enabled'; budget_tokens: number }

export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'refusal'
  | 'other'

/** What a single model turn produced. */
export interface TurnResult {
  text: string
  toolCalls: ToolCall[]
  stopReason: StopReason
  usage: {
    /** Uncached input tokens (billed at full rate). */
    inputTokens: number
    outputTokens: number
    /** Tokens served from the prompt cache (billed at ~0.1x). */
    cacheReadTokens?: number
    /** Tokens written to the prompt cache (billed at ~1.25x). */
    cacheCreationTokens?: number
  }
  /** Provider-native content, replayed verbatim on the next turn. */
  native?: unknown
}

/** A single request for one model turn. */
export interface TurnRequest {
  model: string
  system: string
  maxTokens: number
  tools: ToolSchema[]
  messages: ConvMessage[]
  thinking?: ThinkingConfig
  signal?: AbortSignal
}
