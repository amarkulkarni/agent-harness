import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { createAgent, defineTool, runAgent } from '../src/index.js'
import type { LLMProvider, ProviderStreamEvent } from '../src/provider/types.js'
import type { AgentEvent } from '../src/events.js'
import type { TurnResult } from '../src/types.js'

/** A provider driven by a scripted list of turns — no network. */
class MockProvider implements LLMProvider {
  private i = 0
  constructor(private readonly turns: TurnResult[]) {}
  async *streamTurn(): AsyncIterable<ProviderStreamEvent> {
    yield { type: 'text', text: `[turn ${this.i}] ` }
    const result =
      this.turns[this.i++] ??
      { text: 'default', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
    yield { type: 'done', result }
  }
}

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

const echoTool = defineTool({
  name: 'echo',
  description: 'Echo the given text back.',
  input: z.object({ text: z.string() }),
  handler: ({ text }) => `echoed: ${text}`
})

test('runs a multi-turn tool loop and finishes on end_turn', async () => {
  // Turn 1: call echo. Turn 2: finish.
  const provider = new MockProvider([
    {
      text: 'calling tool',
      toolCalls: [{ id: 'tc1', name: 'echo', input: { text: 'hi' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 100, outputTokens: 20 }
    },
    {
      text: 'all done',
      toolCalls: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 50, outputTokens: 10 }
    }
  ])

  const agent = createAgent({
    system: 'test',
    tools: [echoTool],
    model: 'claude-opus-4-8',
    provider
  })

  const events = await collect(runAgent(agent, { prompt: 'go' }))

  const toolCall = events.find((e) => e.type === 'tool_call')
  assert.equal(toolCall?.type === 'tool_call' && toolCall.name, 'echo')

  const toolResult = events.find((e) => e.type === 'tool_result')
  assert.equal(toolResult?.type === 'tool_result' && toolResult.content, 'echoed: hi')
  assert.equal(toolResult?.type === 'tool_result' && toolResult.isError, false)

  const done = events.at(-1)
  assert.equal(done?.type, 'done')
  if (done?.type === 'done') {
    assert.equal(done.reason, 'end_turn')
    assert.equal(done.turns, 2)
    assert.equal(done.finalText, 'all done')
    // Cost accumulated across both turns: (150 in * $5 + 30 out * $25) / 1e6
    assert.equal(done.usage.inputTokens, 150)
    assert.equal(done.usage.outputTokens, 30)
    const expected = (150 * 5 + 30 * 25) / 1_000_000
    assert.ok(Math.abs(done.usage.costUSD - expected) < 1e-12)
  }
})

test('stops at the maxTurns guardrail', async () => {
  // Always asks for a tool → would loop forever without the guardrail.
  const looping: TurnResult = {
    text: 'again',
    toolCalls: [{ id: 'tc', name: 'echo', input: { text: 'x' } }],
    stopReason: 'tool_use',
    usage: { inputTokens: 10, outputTokens: 2 }
  }
  const provider = new MockProvider(Array.from({ length: 100 }, () => looping))

  const agent = createAgent({
    system: 'test',
    tools: [echoTool],
    provider,
    guardrails: { maxTurns: 3 }
  })

  const events = await collect(runAgent(agent, { prompt: 'go' }))
  const done = events.at(-1)
  assert.equal(done?.type, 'done')
  if (done?.type === 'done') {
    assert.equal(done.reason, 'max_turns')
    assert.equal(done.turns, 3)
  }
})

test('stops at the maxCostUSD guardrail', async () => {
  const pricey: TurnResult = {
    text: 'spending',
    toolCalls: [{ id: 'tc', name: 'echo', input: { text: 'x' } }],
    stopReason: 'tool_use',
    usage: { inputTokens: 100_000, outputTokens: 100_000 }
  }
  const provider = new MockProvider(Array.from({ length: 100 }, () => pricey))

  const agent = createAgent({
    system: 'test',
    tools: [echoTool],
    model: 'claude-opus-4-8',
    provider,
    guardrails: { maxCostUSD: 1.0 }
  })

  const events = await collect(runAgent(agent, { prompt: 'go' }))
  const done = events.at(-1)
  assert.equal(done?.type, 'done')
  if (done?.type === 'done') {
    assert.equal(done.reason, 'max_cost')
    assert.ok(done.usage.costUSD >= 1.0)
  }
})

test('approval hook can deny a tool call', async () => {
  const provider = new MockProvider([
    {
      text: '',
      toolCalls: [{ id: 'tc1', name: 'echo', input: { text: 'hi' } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 2 }
    },
    { text: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 1 } }
  ])

  const agent = createAgent({
    system: 'test',
    tools: [echoTool],
    provider,
    guardrails: { approve: () => false }
  })

  const events = await collect(runAgent(agent, { prompt: 'go' }))
  const toolResult = events.find((e) => e.type === 'tool_result')
  assert.equal(toolResult?.type === 'tool_result' && toolResult.isError, true)
  assert.match(
    toolResult?.type === 'tool_result' ? toolResult.content : '',
    /Denied by approval policy/
  )
})

test('runs multiple tool calls in one turn concurrently, results in order', async () => {
  const order: string[] = []
  const slow = defineTool({
    name: 'slow',
    description: 'Resolves after a tick.',
    input: z.object({}),
    handler: async () => {
      await new Promise((r) => setTimeout(r, 30))
      order.push('slow')
      return 'slow-done'
    }
  })
  const fast = defineTool({
    name: 'fast',
    description: 'Resolves immediately.',
    input: z.object({}),
    handler: () => {
      order.push('fast')
      return 'fast-done'
    }
  })

  const provider = new MockProvider([
    {
      text: '',
      // slow is requested first, fast second
      toolCalls: [
        { id: 'a', name: 'slow', input: {} },
        { id: 'b', name: 'fast', input: {} }
      ],
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 2 }
    },
    { text: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 1 } }
  ])

  const agent = createAgent({ system: 'test', tools: [slow, fast], provider })
  const events = await collect(runAgent(agent, { prompt: 'go' }))

  // Ran concurrently: fast finished before slow even though it was requested second.
  assert.deepEqual(order, ['fast', 'slow'])

  // But results are emitted/fed back in the model's original order.
  const results = events.filter((e) => e.type === 'tool_result')
  assert.deepEqual(
    results.map((e) => (e.type === 'tool_result' ? e.content : '')),
    ['slow-done', 'fast-done']
  )
})

test('invalid tool input is reported as an error result', async () => {
  const provider = new MockProvider([
    {
      text: '',
      toolCalls: [{ id: 'tc1', name: 'echo', input: { wrong: 1 } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 2 }
    },
    { text: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 1 } }
  ])

  const agent = createAgent({ system: 'test', tools: [echoTool], provider })
  const events = await collect(runAgent(agent, { prompt: 'go' }))
  const toolResult = events.find((e) => e.type === 'tool_result')
  assert.equal(toolResult?.type === 'tool_result' && toolResult.isError, true)
  assert.match(
    toolResult?.type === 'tool_result' ? toolResult.content : '',
    /Invalid input for echo/
  )
})
