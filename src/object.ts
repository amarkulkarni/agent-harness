import { z } from 'zod'
import type { Agent } from './agent.js'
import type { RunInput } from './loop.js'
import { runAgent } from './loop.js'
import { defineTool } from './tool.js'
import type { StopReason } from './types.js'
import type { UsageTotals } from './events.js'

export interface ObjectResult<T> {
  /** The validated, typed object the agent produced. */
  object: T
  /** Any prose the agent emitted alongside the result (often empty). */
  text: string
  turns: number
  usage: UsageTotals
}

const ZERO: UsageTotals = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUSD: 0
}

/**
 * Run an agent and get back a validated, typed object instead of free text.
 *
 * Works by giving the agent a synthetic `submit_result` tool whose input schema
 * *is* your Zod schema — the agent does its normal tool work, then calls it to
 * hand back the answer. Provider-agnostic (uses the same tool machinery as
 * everything else) and validated with Zod before it's returned.
 *
 * ```ts
 * const { object } = await runAgentForObject(
 *   agent,
 *   { prompt: 'Extract the invoice fields from ./invoice.txt' },
 *   z.object({ total: z.number(), dueDate: z.string() })
 * )
 * object.total // number
 * ```
 *
 * A non-object schema (e.g. `z.enum([...])`) is wrapped automatically and
 * unwrapped on return, so classification-style calls work too.
 */
export async function runAgentForObject<S extends z.ZodType>(
  agent: Agent,
  input: RunInput,
  schema: S,
  opts: { toolName?: string } = {}
): Promise<ObjectResult<z.infer<S>>> {
  const toolName = opts.toolName ?? 'submit_result'

  // Anthropic tool inputs must be objects; wrap scalar/enum/array schemas.
  const wrap = !(schema instanceof z.ZodObject)
  const effective = wrap ? z.object({ result: schema }) : schema

  const submit = defineTool({
    name: toolName,
    description:
      'Submit the final answer as structured data. Call this exactly once, when you have the complete result.',
    input: effective,
    handler: () => 'Result recorded.'
  })

  const augmented: Agent = {
    ...agent,
    tools: [...agent.tools, submit],
    system:
      agent.system +
      `\n\nWhen you have the final answer, call the \`${toolName}\` tool with it. ` +
      `Provide the answer only through that tool — do not put it in prose.`
  }

  let pendingId: string | undefined
  let pendingInput: unknown
  let captured: { value: unknown } | undefined
  let usage: UsageTotals = ZERO
  let turns = 0
  let text = ''
  let doneReason: StopReason | 'max_turns' | 'max_cost' | undefined

  for await (const ev of runAgent(augmented, input)) {
    switch (ev.type) {
      case 'usage':
        usage = usageFrom(ev)
        turns = ev.turn
        break
      case 'tool_call':
        if (ev.name === toolName) {
          pendingId = ev.id
          pendingInput = ev.input
        }
        break
      case 'tool_result':
        // The loop already validated against `effective`; a non-error result
        // for our submit tool means the input is good.
        if (ev.id === pendingId && !ev.isError) {
          const parsed = effective.safeParse(pendingInput)
          if (parsed.success) {
            captured = { value: wrap ? (parsed.data as { result: unknown }).result : parsed.data }
          }
        }
        break
      case 'done':
        text = ev.finalText
        usage = ev.usage
        turns = ev.turns
        doneReason = ev.reason
        break
      case 'error':
        throw new Error(`Agent errored: ${ev.message}`)
    }
    if (captured) break // got the object — stop early, skip the next model turn
  }

  if (!captured) {
    throw new Error(
      `Agent finished (${doneReason ?? 'unknown'}) without calling ${toolName}. ` +
        `The model did not produce a result matching the schema.`
    )
  }

  return { object: captured.value as z.infer<S>, text, turns, usage }
}

function usageFrom(ev: Extract<import('./events.js').AgentEvent, { type: 'usage' }>): UsageTotals {
  return {
    inputTokens: ev.inputTokens,
    outputTokens: ev.outputTokens,
    cacheReadTokens: ev.cacheReadTokens,
    cacheCreationTokens: ev.cacheCreationTokens,
    costUSD: ev.costUSD
  }
}
