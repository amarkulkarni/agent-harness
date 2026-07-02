import { z } from 'zod'

/** Passed to every tool handler. */
export interface ToolContext {
  /** Aborts if the run is cancelled. */
  signal?: AbortSignal
}

/**
 * A tool: a name, a description the model reads to decide when to call it,
 * a Zod schema for the input (which also generates the JSON Schema sent to
 * the API), and a handler that receives the parsed, typed input.
 */
export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string
  description: string
  schema: S
  jsonSchema: Record<string, unknown>
  handler: (input: z.infer<S>, ctx: ToolContext) => string | Promise<string>
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
}): Tool<S> {
  // Zod v4 ships a native JSON Schema converter.
  const jsonSchema = z.toJSONSchema(def.input) as Record<string, unknown>
  // Anthropic's input_schema doesn't want the JSON Schema meta key.
  delete jsonSchema.$schema
  return {
    name: def.name,
    description: def.description,
    schema: def.input,
    jsonSchema,
    handler: def.handler
  }
}
