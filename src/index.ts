/**
 * agent-harness — a tiny, provider-agnostic harness for tool-using agents.
 *
 * An agent is a system prompt + a set of typed tools. The loop, streaming,
 * cost tracking, and guardrails come for free.
 */
export { defineTool } from './tool.js'
export type { Tool, ToolContext } from './tool.js'

export { createAgent } from './agent.js'
export type { Agent, AgentConfig, Guardrails } from './agent.js'

export { runAgent } from './loop.js'
export type { RunInput } from './loop.js'

export { runAgentForObject } from './object.js'
export type { ObjectResult } from './object.js'

export type { AgentEvent, UsageTotals } from './events.js'

export { AnthropicProvider } from './provider/anthropic.js'
export type { LLMProvider, ProviderStreamEvent } from './provider/types.js'

export { PRICING, costUSD } from './cost.js'
export type { ModelPricing } from './cost.js'

export { connectMcp, wrapMcpTools, renderMcpContent } from './mcp.js'
export type { McpConnection, McpToolClient, McpTransportOptions } from './mcp.js'

export type {
  ToolCall,
  ToolResult,
  ToolSchema,
  ConvMessage,
  ThinkingConfig,
  StopReason,
  TurnResult,
  TurnRequest
} from './types.js'
