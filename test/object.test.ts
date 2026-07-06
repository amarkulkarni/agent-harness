import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { createAgent, runAgentForObject } from '../src/index.js'
import type { LLMProvider, ProviderStreamEvent } from '../src/provider/types.js'
import type { TurnResult } from '../src/types.js'

/** Provider that plays scripted turns. */
function scripted(turns: TurnResult[]): LLMProvider {
  let i = 0
  return {
    async *streamTurn(): AsyncIterable<ProviderStreamEvent> {
      yield { type: 'done', result: turns[i++] }
    }
  }
}

const usage = { inputTokens: 10, outputTokens: 5 }

test('returns a validated typed object from a submit_result tool call', async () => {
  const provider = scripted([
    {
      text: '',
      toolCalls: [
        { id: 's1', name: 'submit_result', input: { total: 42, dueDate: '2026-08-01' } }
      ],
      stopReason: 'tool_use',
      usage
    }
  ])
  const agent = createAgent({ system: 'extract invoices', provider })

  const { object, turns } = await runAgentForObject(
    agent,
    { prompt: 'extract' },
    z.object({ total: z.number(), dueDate: z.string() })
  )

  assert.equal(object.total, 42)
  assert.equal(object.dueDate, '2026-08-01')
  assert.equal(turns, 1)
})

test('wraps and unwraps a non-object (enum) schema', async () => {
  const provider = scripted([
    {
      text: '',
      // wrapped as { result: <enum> }
      toolCalls: [{ id: 's1', name: 'submit_result', input: { result: 'positive' } }],
      stopReason: 'tool_use',
      usage
    }
  ])
  const agent = createAgent({ system: 'classify sentiment', provider })

  const { object } = await runAgentForObject(
    agent,
    { prompt: 'classify' },
    z.enum(['positive', 'negative', 'neutral'])
  )

  assert.equal(object, 'positive')
})

test('agent can use other tools before submitting', async () => {
  // Turn 1: call a normal tool. Turn 2: submit the result.
  const provider = scripted([
    {
      text: '',
      toolCalls: [{ id: 't1', name: 'lookup', input: { id: 7 } }],
      stopReason: 'tool_use',
      usage
    },
    {
      text: 'here it is',
      toolCalls: [{ id: 's1', name: 'submit_result', input: { name: 'Widget' } }],
      stopReason: 'tool_use',
      usage
    }
  ])
  const { defineTool } = await import('../src/index.js')
  const lookup = defineTool({
    name: 'lookup',
    description: 'Look up a record.',
    input: z.object({ id: z.number() }),
    handler: ({ id }) => `record ${id}: Widget`
  })
  const agent = createAgent({ system: 'lookup then submit', tools: [lookup], provider })

  const { object, turns } = await runAgentForObject(
    agent,
    { prompt: 'get name for 7' },
    z.object({ name: z.string() })
  )
  assert.equal(object.name, 'Widget')
  assert.equal(turns, 2)
})

test('throws if the agent finishes without submitting', async () => {
  const provider = scripted([
    { text: 'I refuse to use the tool', toolCalls: [], stopReason: 'end_turn', usage }
  ])
  const agent = createAgent({ system: 'extract', provider })

  await assert.rejects(
    () => runAgentForObject(agent, { prompt: 'x' }, z.object({ a: z.string() })),
    /without calling submit_result/
  )
})
