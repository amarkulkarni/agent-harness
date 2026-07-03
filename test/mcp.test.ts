import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAgent, runAgent, wrapMcpTools, renderMcpContent } from '../src/index.js'
import type { McpToolClient } from '../src/index.js'
import type { LLMProvider, ProviderStreamEvent } from '../src/provider/types.js'
import type { AgentEvent } from '../src/events.js'
import type { TurnResult } from '../src/types.js'

/** A fake MCP client — no subprocess, deterministic. */
function fakeMcpClient(calls: Array<{ name: string; arguments?: Record<string, unknown> }>): McpToolClient {
  return {
    async listTools() {
      return {
        tools: [
          {
            name: 'current_time',
            description: 'Return the time for a timezone.',
            inputSchema: {
              type: 'object',
              properties: { timezone: { type: 'string' } },
              required: ['timezone']
            }
          },
          { name: 'ping', description: 'Health check.', inputSchema: { type: 'object', properties: {} } }
        ]
      }
    },
    async callTool(params) {
      calls.push(params)
      if (params.name === 'current_time') {
        return { content: [{ type: 'text', text: `12:00 in ${params.arguments?.timezone}` }] }
      }
      if (params.name === 'boom') {
        return { content: [{ type: 'text', text: 'kaboom' }], isError: true }
      }
      return { content: [{ type: 'text', text: 'pong' }] }
    }
  }
}

test('wrapMcpTools exposes tools with prefix, schema, and working handlers', async () => {
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = []
  const tools = await wrapMcpTools(fakeMcpClient(calls), { prefix: 'time__' })

  assert.deepEqual(tools.map((t) => t.name), ['time__current_time', 'time__ping'])
  // No Zod schema (MCP tools carry JSON Schema only).
  assert.equal(tools[0].schema, undefined)
  assert.equal((tools[0].jsonSchema as { required?: string[] }).required?.[0], 'timezone')

  const out = await tools[0].handler({ timezone: 'UTC' }, {})
  assert.equal(out, '12:00 in UTC')
  // Handler calls the *unprefixed* MCP name.
  assert.equal(calls[0].name, 'current_time')
})

test('wrapMcpTools handler throws when the MCP result isError', async () => {
  const client: McpToolClient = {
    async listTools() {
      return { tools: [{ name: 'boom', inputSchema: { type: 'object', properties: {} } }] }
    },
    async callTool() {
      return { content: [{ type: 'text', text: 'kaboom' }], isError: true }
    }
  }
  const [tool] = await wrapMcpTools(client)
  await assert.rejects(() => Promise.resolve(tool.handler({}, {})), /kaboom/)
})

test('renderMcpContent flattens text and resource blocks', () => {
  assert.equal(renderMcpContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(
    renderMcpContent([{ type: 'resource', resource: { uri: 'file://x', text: 'body' } }]),
    'body'
  )
  assert.equal(renderMcpContent('plain'), 'plain')
})

test('wrapped MCP tools run inside the agent loop', async () => {
  const calls: Array<{ name: string; arguments?: Record<string, unknown> }> = []
  const tools = await wrapMcpTools(fakeMcpClient(calls))

  // Model asks for current_time, then finishes.
  const turns: TurnResult[] = [
    {
      text: '',
      toolCalls: [{ id: 'c1', name: 'current_time', input: { timezone: 'Asia/Tokyo' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 2 }
    },
    { text: 'It is noon.', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 3 } }
  ]
  let i = 0
  const provider: LLMProvider = {
    async *streamTurn(): AsyncIterable<ProviderStreamEvent> {
      yield { type: 'done', result: turns[i++] }
    }
  }

  const agent = createAgent({ system: 'test', tools, provider })
  const events: AgentEvent[] = []
  for await (const ev of runAgent(agent, { prompt: 'time in tokyo?' })) events.push(ev)

  const result = events.find((e) => e.type === 'tool_result')
  assert.equal(result?.type === 'tool_result' && result.content, '12:00 in Asia/Tokyo')
  assert.equal(calls[0].name, 'current_time')
  assert.equal(calls[0].arguments?.timezone, 'Asia/Tokyo')
})
