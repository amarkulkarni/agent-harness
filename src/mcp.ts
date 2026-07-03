import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Tool } from './tool.js'

/**
 * Minimal shape of an MCP client the wrapper needs. `Client` from the MCP SDK
 * satisfies it; a fake satisfies it too (handy for tests).
 */
export interface McpToolClient {
  listTools(): Promise<{
    tools: Array<{ name: string; description?: string; inputSchema?: unknown }>
  }>
  callTool(params: {
    name: string
    arguments?: Record<string, unknown>
  }): Promise<{ content?: unknown; isError?: boolean }>
}

/**
 * Turn every tool exposed by a connected MCP client into a harness {@link Tool}.
 * MCP tools carry their own JSON Schema, so the wrapped tools have no Zod
 * schema — the loop passes inputs straight through, and the MCP server does the
 * validating.
 *
 * @param opts.prefix Optional string prepended to each exposed tool name (e.g.
 *   `'github__'`) to avoid collisions when wiring multiple servers.
 */
export async function wrapMcpTools(
  client: McpToolClient,
  opts: { prefix?: string } = {}
): Promise<Tool[]> {
  const { tools } = await client.listTools()
  const prefix = opts.prefix ?? ''
  return tools.map((t): Tool => ({
    name: prefix + t.name,
    description: t.description ?? '',
    jsonSchema: (t.inputSchema as Record<string, unknown>) ?? { type: 'object', properties: {} },
    handler: async (input) => {
      const res = await client.callTool({
        name: t.name,
        arguments: (input ?? {}) as Record<string, unknown>
      })
      const text = renderMcpContent(res.content)
      if (res.isError) throw new Error(text || `MCP tool ${t.name} returned an error`)
      return text
    }
  }))
}

/** Flatten an MCP tool result's content blocks into a single string. */
export function renderMcpContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content)
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object') {
      const b = block as Record<string, unknown>
      if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      else if (b.type === 'resource' && b.resource && typeof b.resource === 'object') {
        const r = b.resource as Record<string, unknown>
        parts.push(typeof r.text === 'string' ? r.text : `[resource ${String(r.uri ?? '')}]`)
      } else parts.push(`[${String(b.type ?? 'content')}]`)
    }
  }
  return parts.join('\n')
}

/** How to reach an MCP server. */
export type McpTransportOptions =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }

export interface McpConnection {
  /** The server's tools, ready to pass to `createAgent({ tools })`. */
  tools: Tool[]
  /** The underlying MCP client, for advanced use. */
  client: Client
  /** Close the connection (and terminate a spawned stdio server). */
  close: () => Promise<void>
}

/**
 * Connect to an MCP server and return its tools wrapped as harness tools.
 *
 * ```ts
 * const mcp = await connectMcp({ type: 'stdio', command: 'my-mcp-server' })
 * const agent = createAgent({ system: '...', tools: mcp.tools })
 * // ... run the agent ...
 * await mcp.close()
 * ```
 */
export async function connectMcp(
  transport: McpTransportOptions,
  opts: { name?: string; version?: string; prefix?: string } = {}
): Promise<McpConnection> {
  const client = new Client({
    name: opts.name ?? 'agent-harness',
    version: opts.version ?? '0.1.0'
  })

  if (transport.type === 'stdio') {
    await client.connect(
      new StdioClientTransport({
        command: transport.command,
        args: transport.args,
        env: transport.env
          ? { ...getDefaultEnvironment(), ...transport.env }
          : undefined
      })
    )
  } else {
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(transport.url),
        transport.headers ? { requestInit: { headers: transport.headers } } : undefined
      )
    )
  }

  // `Client` structurally matches McpToolClient at runtime; its callTool return
  // is a wider union (legacy toolResult shape) that TS won't narrow — cast.
  const tools = await wrapMcpTools(client as unknown as McpToolClient, { prefix: opts.prefix })
  return { tools, client, close: () => client.close() }
}
