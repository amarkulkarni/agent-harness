/**
 * A minimal MCP server (stdio) exposing one tool, used by the MCP example and
 * test. Run indirectly — the client spawns it. This is a stand-in for any real
 * MCP server (GitHub, Slack, a database, …).
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'time-server', version: '1.0.0' })

server.registerTool(
  'current_time',
  {
    title: 'Current time',
    description: 'Return the current date and time for a given IANA timezone.',
    inputSchema: {
      timezone: z.string().describe('IANA timezone, e.g. America/New_York or UTC')
    }
  },
  async ({ timezone }) => {
    const now = new Date().toLocaleString('en-US', { timeZone: timezone, timeZoneName: 'short' })
    return { content: [{ type: 'text', text: `${now} (${timezone})` }] }
  }
)

await server.connect(new StdioServerTransport())
