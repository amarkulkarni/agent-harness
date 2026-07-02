import Anthropic from '@anthropic-ai/sdk'
import type { ConvMessage, StopReason, ToolCall, TurnRequest, TurnResult } from '../types.js'
import type { LLMProvider, ProviderStreamEvent } from './types.js'

/**
 * Anthropic Messages API provider. Streams text deltas and returns a
 * normalized {@link TurnResult}. The SDK client is created lazily so importing
 * the harness without an API key never throws.
 */
export class AnthropicProvider implements LLMProvider {
  private client: Anthropic | undefined
  private readonly apiKey: string | undefined

  constructor(opts: { apiKey?: string } = {}) {
    this.apiKey = opts.apiKey
  }

  private getClient(): Anthropic {
    if (this.client) return this.client
    const key = this.apiKey ?? process.env.ANTHROPIC_API_KEY
    if (!key) {
      throw new Error(
        'ANTHROPIC_API_KEY is not set. Export it or pass { apiKey } to AnthropicProvider.'
      )
    }
    this.client = new Anthropic({ apiKey: key })
    return this.client
  }

  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderStreamEvent> {
    const client = this.getClient()

    // Build request params. `thinking` is passed through when set; kept out of
    // the base object so the harness works across SDK/model versions when unset.
    const params: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages.map(toApiMessage),
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema
      }))
    }
    if (req.thinking) params.thinking = req.thinking

    const stream = client.messages.stream(params as Anthropic.MessageStreamParams, {
      signal: req.signal
    })

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text }
      }
    }

    const final = await stream.finalMessage()
    yield { type: 'done', result: toTurnResult(final) }
  }
}

/** Normalize a finished Anthropic message into a TurnResult. */
function toTurnResult(msg: Anthropic.Message): TurnResult {
  let text = ''
  const toolCalls: ToolCall[] = []
  for (const block of msg.content) {
    if (block.type === 'text') text += block.text
    else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, input: block.input })
    }
  }
  return {
    text,
    toolCalls,
    stopReason: mapStopReason(msg.stop_reason),
    usage: {
      inputTokens: msg.usage?.input_tokens ?? 0,
      outputTokens: msg.usage?.output_tokens ?? 0
    },
    // Preserve the raw content array so the next turn replays it verbatim
    // (keeps thinking blocks + signatures intact).
    native: msg.content
  }
}

function mapStopReason(reason: string | null): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'refusal':
      return reason
    default:
      return 'other'
  }
}

/** Translate a normalized ConvMessage into an Anthropic MessageParam. */
function toApiMessage(m: ConvMessage): Anthropic.MessageParam {
  if (m.role === 'user') {
    return { role: 'user', content: m.text }
  }
  if (m.role === 'tool') {
    return {
      role: 'user',
      content: m.results.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.id,
        content: r.content,
        is_error: r.isError
      }))
    }
  }
  // assistant — replay native content when we have it (preserves thinking blocks),
  // otherwise reconstruct from text + tool calls.
  if (m.native) {
    return { role: 'assistant', content: m.native as Anthropic.ContentBlockParam[] }
  }
  const content: Anthropic.ContentBlockParam[] = []
  if (m.text) content.push({ type: 'text', text: m.text })
  for (const c of m.toolCalls) {
    content.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input })
  }
  return { role: 'assistant', content }
}
