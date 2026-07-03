import { z } from 'zod'

/** Passed to every tool handler. */
export interface ToolContext {
  /** Aborts if the run is cancelled. */
  signal?: AbortSignal
}

/**
 * A tool the model can call. `jsonSchema` is always sent to the API. `schema`
 * is an optional Zod schema — when present, inputs are validated against it
 * before the handler runs (this is what `defineTool` sets). Tools that only
 * have a JSON Schema (e.g. wrapped MCP tools) omit it.
 */
export interface Tool {
  name: string
  description: string
  jsonSchema: Record<string, unknown>
  schema?: z.ZodType
  handler: (input: unknown, ctx: ToolContext) => string | Promise<string>
}

/**
 * Define a tool. The handler's `input` is fully typed from the Zod schema,
 * and inputs are validated against it before the handler runs.
 *
 * ```ts
 * const readFile = defineTool({
 *   name: 'read_file',
 *   description: 'Read a UTF-8 text file. Call when you need a file\'s contents.',
 *   input: z.object({ path: z.string() }),
 *   handler: async ({ path }) => fs.readFile(path, 'utf8'),
 * })
 * ```
 */
export function defineTool<S extends z.ZodType>(def: {
  name: string
  description: string
  input: S
  handler: (input: z.infer<S>, ctx: ToolContext) => string | Promise<string>
}): Tool {
  // Zod v4 ships a native JSON Schema converter.
  const jsonSchema = z.toJSONSchema(def.input) as Record<string, unknown>
  // Anthropic's input_schema doesn't want the JSON Schema meta key.
  delete jsonSchema.$schema
  return {
    name: def.name,
    description: def.description,
    jsonSchema,
    schema: def.input,
    handler: def.handler as Tool['handler']
  }
}
