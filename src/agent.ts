import type { ToolCall, ThinkingConfig } from './types.js'
import type { Tool } from './tool.js'
import type { LLMProvider } from './provider/types.js'
import { AnthropicProvider } from './provider/anthropic.js'

/** Budgets and approval hook that bound a run. */
export interface Guardrails {
  /** Max model turns before the loop stops. Default 50. */
  maxTurns?: number
  /** Stop once estimated spend reaches this many USD. Default: unbounded. */
  maxCostUSD?: number
  /**
   * Called before each tool executes. Return false to deny — the model gets an
   * error result and can adapt. Default: allow everything.
   */
  approve?: (call: ToolCall) => boolean | Promise<boolean>
}

export interface AgentConfig {
  /** System prompt — defines the agent's behavior. */
  system: string
  /** Tools the agent may call. */
  tools?: Tool[]
  /** Model id. Default 'claude-opus-4-8'. */
  model?: string
  /** Max output tokens per turn. Default 8192. */
  maxTokens?: number
  /** Thinking configuration, passed through to the provider. Default: off. */
  thinking?: ThinkingConfig
  guardrails?: Guardrails
  /** Override the LLM provider. Default: AnthropicProvider (reads ANTHROPIC_API_KEY). */
  provider?: LLMProvider
}

/** A fully-resolved agent, ready to hand to `runAgent`. */
export interface Agent {
  system: string
  tools: Tool[]
  model: string
  maxTokens: number
  thinking?: ThinkingConfig
  maxTurns: number
  maxCostUSD?: number
  approve?: (call: ToolCall) => boolean | Promise<boolean>
  provider: LLMProvider
}

const DEFAULT_MODEL = 'claude-opus-4-8'
const DEFAULT_MAX_TOKENS = 8192
const DEFAULT_MAX_TURNS = 50

/** Resolve an AgentConfig into a runnable Agent, filling in defaults. */
export function createAgent(cfg: AgentConfig): Agent {
  return {
    system: cfg.system,
    tools: cfg.tools ?? [],
    model: cfg.model ?? DEFAULT_MODEL,
    maxTokens: cfg.maxTokens ?? DEFAULT_MAX_TOKENS,
    thinking: cfg.thinking,
    maxTurns: cfg.guardrails?.maxTurns ?? DEFAULT_MAX_TURNS,
    maxCostUSD: cfg.guardrails?.maxCostUSD,
    approve: cfg.guardrails?.approve,
    provider: cfg.provider ?? new AnthropicProvider()
  }
}
