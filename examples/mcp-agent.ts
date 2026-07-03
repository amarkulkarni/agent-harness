/**
 * MCP example: connect to an MCP server, hand its tools to an agent, run a
 * prompt, then close. This is the whole point of the MCP client — the agent's
 * tools come from the server with zero per-tool wiring.
 *
 *   npm run example:mcp -- "what time is it in Tokyo right now?"
 *
 * Requires ANTHROPIC_API_KEY. Swap the transport below for any real MCP server
 * (a hosted URL via { type: 'http', url, headers }, or another stdio command).
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { connectMcp, createAgent } from '../src/index.js'
import { printRun } from '../src/cli.js'

const here = dirname(fileURLToPath(import.meta.url))
const prompt = process.argv.slice(2).join(' ') || 'What time is it in Tokyo and in London right now?'

const mcp = await connectMcp({
  type: 'stdio',
  command: 'node',
  args: ['--import', 'tsx', join(here, 'mcp-time-server.ts')]
})

try {
  console.log(`\x1b[90mConnected to MCP server — tools: ${mcp.tools.map((t) => t.name).join(', ')}\x1b[0m\n`)
  const agent = createAgent({
    system: 'You are a helpful assistant. Use the available tools to answer questions about the current time.',
    tools: mcp.tools
  })
  await printRun(agent, prompt)
} finally {
  await mcp.close()
}
