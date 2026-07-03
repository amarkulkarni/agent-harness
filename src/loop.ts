import type { Agent } from './agent.js'
import type { Tool } from './tool.js'
import type { AgentEvent, UsageTotals } from './events.js'
import type { ConvMessage, ToolCall, ToolResult } from './types.js'
import { costUSD } from './cost.js'

export interface RunInput {
  /** The user's task / message that kicks off the run. */
  prompt: string
  /** Cancels the run and any in-flight tool. */
  signal?: AbortSignal
}

/**
 * Run an agent to completion, yielding a stream of events. This is the whole
 * harness: a generic tool-use loop that is agnostic to the model (via the
 * provider) and to the agent (via its system prompt + tools).
 *
 * ```ts
 * for await (const ev of runAgent(agent, { prompt: 'summarize ./notes' })) {
 *   if (ev.type === 'text') process.stdout.write(ev.text)
 * }
 * ```
 */
export async function* runAgent(agent: Agent, input: RunInput): AsyncGenerator<AgentEvent> {
  const toolsByName = new Map<string, Tool>(agent.tools.map((t) => [t.name, t]))
  const toolSchemas = agent.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.jsonSchema
  }))

  const messages: ConvMessage[] = [{ role: 'user', text: input.prompt }]
  let inputTokens = 0
  let outputTokens = 0
  let turns = 0
  let finalText = ''

  const totals = (): UsageTotals => ({
    inputTokens,
    outputTokens,
    costUSD: costUSD(agent.model, inputTokens, outputTokens)
  })

  while (true) {
    // --- Guardrails: checked before spending another turn ---
    if (turns >= agent.maxTurns) {
      yield { type: 'done', reason: 'max_turns', finalText, turns, usage: totals() }
      return
    }
    if (agent.maxCostUSD != null && totals().costUSD >= agent.maxCostUSD) {
      yield { type: 'done', reason: 'max_cost', finalText, turns, usage: totals() }
      return
    }

    turns++

    // --- One model turn ---
    let result
    try {
      const stream = agent.provider.streamTurn({
        model: agent.model,
        system: agent.system,
        maxTokens: agent.maxTokens,
        tools: toolSchemas,
        messages,
        thinking: agent.thinking,
        signal: input.signal
      })
      for await (const ev of stream) {
        if (ev.type === 'text') yield { type: 'text', text: ev.text }
        else result = ev.result
      }
    } catch (err) {
      yield { type: 'error', message: err instanceof Error ? err.message : String(err) }
      return
    }

    if (!result) {
      yield { type: 'error', message: 'Provider ended a turn without a result.' }
      return
    }

    inputTokens += result.usage.inputTokens
    outputTokens += result.usage.outputTokens
    if (result.text) finalText = result.text
    yield { type: 'usage', turn: turns, ...totals() }

    messages.push({
      role: 'assistant',
      text: result.text,
      toolCalls: result.toolCalls,
      native: result.native
    })

    // --- No tools requested → the run is done ---
    if (result.toolCalls.length === 0) {
      yield { type: 'done', reason: result.stopReason, finalText, turns, usage: totals() }
      return
    }

    // --- Execute the requested tools concurrently, preserving order ---
    // A turn can contain several tool_use blocks; run them in parallel but
    // emit events (and feed results back) in the model's original order.
    for (const call of result.toolCalls) {
      yield { type: 'tool_call', id: call.id, name: call.name, input: call.input }
    }
    const results: ToolResult[] = await Promise.all(
      result.toolCalls.map((call) => executeTool(agent, toolsByName, call, input.signal))
    )
    for (let i = 0; i < results.length; i++) {
      const res = results[i]
      yield {
        type: 'tool_result',
        id: res.id,
        name: result.toolCalls[i].name,
        content: res.content,
        isError: res.isError
      }
    }
    messages.push({ role: 'tool', results })
  }
}

async function executeTool(
  agent: Agent,
  toolsByName: Map<string, Tool>,
  call: ToolCall,
  signal?: AbortSignal
): Promise<ToolResult> {
  const err = (content: string): ToolResult => ({ id: call.id, content, isError: true })

  // Approval hook (guardrail).
  if (agent.approve) {
    let allowed: boolean
    try {
      allowed = await agent.approve(call)
    } catch (e) {
      return err(`Approval hook threw: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (!allowed) return err(`Denied by approval policy: ${call.name}`)
  }

  const tool = toolsByName.get(call.name)
  if (!tool) return err(`Unknown tool: ${call.name}`)

  // Validate input at the boundary when the tool carries a Zod schema.
  // Tools with only a JSON Schema (e.g. wrapped MCP tools) pass through.
  let input: unknown = call.input
  if (tool.schema) {
    const parsed = tool.schema.safeParse(call.input)
    if (!parsed.success) {
      return err(`Invalid input for ${call.name}: ${parsed.error.message}`)
    }
    input = parsed.data
  }

  try {
    const content = await tool.handler(input, { signal })
    return { id: call.id, content, isError: false }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e))
  }
}
