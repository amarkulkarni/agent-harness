# agent-harness

A tiny, provider-agnostic harness for building tool-using agents. **An agent is
just a system prompt + a set of typed tools** — the tool-use loop, streaming,
token/cost tracking, and guardrails come for free. Drop it into any project;
defining a new agent is a handful of lines, not a new framework.

```ts
import { createAgent, defineTool, runAgent } from 'agent-harness'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'

const readFileTool = defineTool({
  name: 'read_file',
  description: "Read a UTF-8 text file. Call when you need a file's contents.",
  input: z.object({ path: z.string() }),
  handler: async ({ path }) => readFile(path, 'utf8')
})

const agent = createAgent({
  system: 'You are a helpful filesystem assistant.',
  tools: [readFileTool],
  model: 'claude-opus-4-8',
  guardrails: { maxTurns: 25, maxCostUSD: 1.0 }
})

for await (const ev of runAgent(agent, { prompt: 'summarize ./notes.md' })) {
  if (ev.type === 'text') process.stdout.write(ev.text)
  if (ev.type === 'done') console.log('\n', ev.reason, ev.usage)
}
```

## Why

Most "agent" code welds the loop to one app, one model, and one hardcoded tool
set. This library extracts just the reusable core:

- **An agent is data.** `createAgent({ system, tools })`. Swap the prompt and
  tools, get a new agent — nothing in the loop is special-cased.
- **Tools are typed functions.** `defineTool` takes a [Zod](https://zod.dev)
  schema; the handler's input is fully typed, inputs are validated at the
  boundary, and the JSON Schema sent to the API is generated for you.
- **Streaming, framework-agnostic.** `runAgent` is an async generator you
  consume with `for await`. Wire it to a CLI, an Electron app, or an HTTP
  server — same event stream.
- **Guardrails built in.** `maxTurns`, `maxCostUSD`, and an `approve()` hook to
  gate risky tools. The loop stops cleanly and tells you why.
- **Model-agnostic.** The loop never imports an SDK — it drives an
  `LLMProvider`. One Anthropic implementation ships; adding another is additive.
- **MCP built in.** Point it at any [MCP](https://modelcontextprotocol.io) server
  and its tools become agent tools automatically — no per-tool wiring.
- **Parallel tools.** When the model requests several tools in one turn, they
  run concurrently; results are fed back in the model's original order.

## Install

```bash
npm install
cp .env.example .env   # add your ANTHROPIC_API_KEY
npm run build
```

Requires Node 18+ and an `ANTHROPIC_API_KEY` (only when using the default
Anthropic provider).

## Concepts

### `defineTool`

```ts
const search = defineTool({
  name: 'search',
  description: 'Search the docs. Call when the user asks about API behavior.',
  input: z.object({ query: z.string(), limit: z.number().optional() }),
  handler: async ({ query, limit }, ctx) => {
    // `query` is string, `limit` is number | undefined — fully typed.
    // ctx.signal aborts if the run is cancelled.
    return runSearch(query, limit ?? 5)
  }
})
```

Return a string (fed back to the model as the tool result). Throwing is fine —
the harness turns it into an error result the model can recover from. Invalid
inputs are rejected against the Zod schema before your handler runs.

### `createAgent`

| Option | Default | Notes |
|---|---|---|
| `system` | — | System prompt (required). |
| `tools` | `[]` | Array of `defineTool` results. |
| `model` | `claude-opus-4-8` | Any Claude model id. |
| `maxTokens` | `8192` | Max output tokens per turn. |
| `thinking` | off | Pass `{ type: 'adaptive' }` to enable extended thinking (Claude 4.6+). |
| `guardrails.maxTurns` | `50` | Hard stop on loop length. |
| `guardrails.maxCostUSD` | unbounded | Stop once estimated spend hits this. |
| `guardrails.approve` | allow all | `(call) => boolean \| Promise<boolean>` — deny risky tool calls. |
| `provider` | `AnthropicProvider` | Swap in a different `LLMProvider`. |

### `runAgent` events

`runAgent(agent, { prompt, signal? })` yields:

| Event | Fields |
|---|---|
| `text` | `text` — streamed model output |
| `tool_call` | `id`, `name`, `input` |
| `tool_result` | `id`, `name`, `content`, `isError` |
| `usage` | `turn`, `inputTokens`, `outputTokens`, `costUSD` (running totals) |
| `done` | `reason` (`end_turn` / `refusal` / `max_tokens` / `max_turns` / `max_cost`), `finalText`, `turns`, `usage` |
| `error` | `message` |

A run always ends with exactly one `done` or one `error`.

## CLI

```bash
agent-harness <agent-module> "<prompt>" [--flag value ...]
```

The module's default export is either an `Agent` or a factory
`(flags) => Agent | Promise<Agent>` that receives the parsed flags. See
[`examples/filesystem-agent.ts`](examples/filesystem-agent.ts).

## Reference agent

A self-contained filesystem assistant (`list_files` / `read_file` /
`write_file`, path-sandboxed to one directory):

```bash
npm run example:fs -- --dir ./playground "create hello.txt with a greeting"
```

It's proof the harness is reusable — the core has no idea what a "filesystem
agent" is; it's just three tools and a prompt.

## MCP: connectors as tools

Connect to any [Model Context Protocol](https://modelcontextprotocol.io) server
and hand its tools straight to an agent — every connector (GitHub, Slack, a
database, a filesystem server…) becomes agent tools with zero per-tool code.

```ts
import { connectMcp, createAgent, runAgent } from 'agent-harness'

// stdio: spawn a local server
const mcp = await connectMcp({ type: 'stdio', command: 'my-mcp-server', args: [] })
// or HTTP: a hosted server
// const mcp = await connectMcp({ type: 'http', url: 'https://…/mcp', headers: { Authorization: `Bearer ${token}` } })

const agent = createAgent({ system: 'You are a helpful assistant.', tools: mcp.tools })
for await (const ev of runAgent(agent, { prompt: '…' })) { /* … */ }
await mcp.close()
```

Wiring several servers? Pass a `prefix` per connection (e.g. `{ prefix: 'github__' }`)
to avoid tool-name collisions. MCP tools carry their own JSON Schema, so they
slot in alongside `defineTool` tools transparently. See
[`examples/mcp-agent.ts`](examples/mcp-agent.ts) (`npm run example:mcp`).

## Cost tracking

Per-model pricing lives in [`src/cost.ts`](src/cost.ts) (USD per 1M tokens).
Every `usage`/`done` event carries a running `costUSD`. Unknown models report
`0` — add an entry to `PRICING` to get dollar figures.

## Extending: a custom provider

Implement one method:

```ts
import type { LLMProvider, ProviderStreamEvent, TurnRequest } from 'agent-harness'

class MyProvider implements LLMProvider {
  async *streamTurn(req: TurnRequest): AsyncIterable<ProviderStreamEvent> {
    // yield { type: 'text', text } for each delta,
    // then exactly one { type: 'done', result } with the turn's TurnResult.
  }
}

const agent = createAgent({ system: '...', tools: [...], provider: new MyProvider() })
```

This is also how the tests run — a mock provider drives the loop with scripted
turns and no network. See [`test/loop.test.ts`](test/loop.test.ts).

## Scripts

| Command | Description |
|---|---|
| `npm run build` | Compile `src/` → `dist/`. |
| `npm run typecheck` | Type-check without emitting. |
| `npm test` | Run the mock-provider + MCP unit tests (no network). |
| `npm run example:fs` | Run the filesystem reference agent. |
| `npm run example:mcp` | Run the MCP example (agent + spawned MCP server). |

## Roadmap

- **npm publish** — so it installs by name into other projects.
- **Prompt caching** — `cache_control` on system + tools for cheaper multi-turn runs.
- **Structured output helper** — `runAgentForObject` returning a validated typed object.
- **Session/transcript persistence** and resumable runs.
- **Additional providers** (OpenAI, local models) behind the existing seam.
