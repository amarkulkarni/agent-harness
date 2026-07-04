import Anthropic from '@anthropic-ai/sdk'
import type { ConvMessage, StopReason, ToolCall, TurnRequest, TurnResult } from '../types.js'
import type { LLMProvider, ProviderStreamEvent } from './types.js'

const CACHE: Anthropic.CacheControlEphemeral = { type: 'ephemeral' }

/**
 * Anthropic Messages API provider. Streams text deltas and returns a
 * normalized {@link TurnResult}. The SDK client is created lazily so importing
 * the harness without an API key never throws.
 *
 * Prompt caching is on by default: a breakpoint on the static prefix
 * (tools + system) and one on the latest message let each turn re-read the
 * prior prompt at ~0.1x instead of full price. Disable with `{ cache: false }`.
 */
export class AnthropicProvider implements LLMProvider {
  private client: Anthropic | undefined
  private readonly apiKey: string | undefined
  private readonly cache: boolean

  constructor(opts: { apiKey?: string; cache?: boolean } = {}) {
    this.apiKey = opts.apiKey
    this.cache = opts.cache ?? true
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

    const tools: Anthropic.ToolUnion[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema
    }))

    const messages = req.messages.map(toApiMessage)

    // System as a text block so it can carry a cache breakpoint. Render order is
    // tools → system → messages, so a breakpoint on system caches tools+system.
    let system: string | Anthropic.TextBlockParam[] = req.system
    if (this.cache) {
      if (req.system) {
        system = [{ type: 'text', text: req.system, cache_control: CACHE }]
      } else if (tools.length > 0) {
        // No system prompt to hang the breakpoint on — cache the tools instead.
        tools[tools.length - 1] = { ...tools[tools.length - 1], cache_control: CACHE }
      }
      // And cache the conversation-so-far by marking the last message.
      markLastMessageForCache(messages)
    }

    const params: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens,
      system,
      messages,
      tools
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

/** Put a cache breakpoint on the last content block of the last message. */
function markLastMessageForCache(messages: Anthropic.MessageParam[]): void {
  const last = messages[messages.length - 1]
  if (!last) return
  if (typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content, cache_control: CACHE }]
    return
  }
  const block = last.content[last.content.length - 1]
  if (block) {
    ;(block as { cache_control?: Anthropic.CacheControlEphemeral }).cache_control = CACHE
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
      outputTokens: msg.usage?.output_tokens ?? 0,
      cacheReadTokens: msg.usage?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: msg.usage?.cache_creation_input_tokens ?? 0
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
