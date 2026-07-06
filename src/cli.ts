#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import type { Agent } from './agent.js'
import { runAgent } from './loop.js'

/**
 * Consume a run and print it to the terminal. Reusable by the CLI below and by
 * example scripts that want the same output.
 */
export async function printRun(agent: Agent, prompt: string): Promise<void> {
  for await (const ev of runAgent(agent, { prompt })) {
    switch (ev.type) {
      case 'text':
        process.stdout.write(ev.text)
        break
      case 'tool_call':
        process.stdout.write(`\n\x1b[36m› ${ev.name}(${JSON.stringify(ev.input)})\x1b[0m\n`)
        break
      case 'tool_result':
        process.stdout.write(
          `\x1b[90m  ${ev.isError ? '✗' : '✓'} ${truncate(ev.content, 200)}\x1b[0m\n`
        )
        break
      case 'done': {
        const cached =
          ev.usage.cacheReadTokens > 0 ? ` (${ev.usage.cacheReadTokens} cached)` : ''
        process.stdout.write(
          `\n\x1b[32m✓ ${ev.reason}\x1b[0m — ${ev.turns} turn(s), ` +
            `${ev.usage.inputTokens}in${cached}/${ev.usage.outputTokens}out tokens, ` +
            `$${ev.usage.costUSD.toFixed(4)}\n`
        )
        break
      }
      case 'error':
        process.stderr.write(`\n\x1b[31m✗ error: ${ev.message}\x1b[0m\n`)
        process.exitCode = 1
        break
    }
  }
}

function truncate(s: string, n: number): string {
  const oneLine = s.replace(/\s+/g, ' ').trim()
  return oneLine.length > n ? oneLine.slice(0, n) + '…' : oneLine
}

/** Parse `key value` and `--flag`-style args after the module path and prompt. */
function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = 'true'
      }
    }
  }
  return flags
}

/**
 * `agent-harness <agent-module> "<prompt>" [--flag value ...]`
 *
 * The module's default export is either an `Agent`, or a factory
 * `(flags) => Agent | Promise<Agent>` that receives the parsed flags.
 */
async function main(): Promise<void> {
  const [, , modulePath, prompt, ...rest] = process.argv
  if (!modulePath || !prompt) {
    process.stderr.write(
      'Usage: agent-harness <agent-module> "<prompt>" [--flag value ...]\n'
    )
    process.exitCode = 1
    return
  }

  const flags = parseFlags(rest)
  const url = pathToFileURL(resolve(modulePath)).href
  const mod = (await import(url)) as { default?: unknown }
  const def = mod.default
  if (def === undefined) {
    throw new Error(`Module ${modulePath} has no default export (expected an Agent or factory).`)
  }
  const agent = (typeof def === 'function' ? await def(flags) : def) as Agent
  await printRun(agent, prompt)
}

// Run only when invoked as the entrypoint (not when imported).
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    process.stderr.write(`\n\x1b[31m${err instanceof Error ? err.stack : String(err)}\x1b[0m\n`)
    process.exitCode = 1
  })
}
