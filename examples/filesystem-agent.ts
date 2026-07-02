/**
 * Reference agent: a filesystem assistant scoped to a single directory.
 *
 * It proves the harness is reusable — a "new agent" is just a system prompt
 * plus a set of `defineTool` tools. Nothing here is special-cased in the core.
 *
 * Run it directly:
 *   npm run example:fs -- --dir ./some-dir "create hello.txt with a greeting"
 *
 * Or via the CLI (its default export is a factory the CLI calls with flags):
 *   agent-harness examples/filesystem-agent.ts "list the files" --dir ./some-dir
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { createAgent, defineTool, type Agent, type Tool } from '../src/index.js'
import { printRun } from '../src/cli.js'

const MAX_READ_CHARS = 100_000
const SKIP = new Set(['.git', 'node_modules'])

/** Resolve a model-supplied relative path, rejecting anything that escapes `root`. */
function safePath(root: string, rel: string): string {
  const base = resolve(root)
  const abs = resolve(base, rel)
  if (abs !== base && !abs.startsWith(base + sep)) {
    throw new Error(`Path "${rel}" escapes the working directory`)
  }
  return abs
}

/** Build the tool set, closing over the directory the agent is scoped to. */
export function filesystemTools(root: string): Tool[] {
  return [
    defineTool({
      name: 'list_files',
      description:
        'List files under the working directory, recursively. Skips .git and node_modules.',
      input: z.object({
        dir: z.string().optional().describe('Subdirectory relative to root. Defaults to root.')
      }),
      handler: async ({ dir }) => {
        const start = safePath(root, dir ?? '.')
        const out: string[] = []
        async function walk(d: string): Promise<void> {
          for (const entry of await readdir(d, { withFileTypes: true })) {
            if (SKIP.has(entry.name)) continue
            const abs = join(d, entry.name)
            if (entry.isDirectory()) await walk(abs)
            else if (entry.isFile()) out.push(relative(root, abs))
          }
        }
        await walk(start)
        return out.length ? out.sort().join('\n') : '(no files)'
      }
    }),
    defineTool({
      name: 'read_file',
      description: 'Read a UTF-8 text file. Path is relative to the working directory.',
      input: z.object({ path: z.string() }),
      handler: async ({ path }) => {
        const content = await readFile(safePath(root, path), 'utf8')
        return content.length > MAX_READ_CHARS
          ? content.slice(0, MAX_READ_CHARS) + `\n\n[truncated at ${MAX_READ_CHARS} chars]`
          : content
      }
    }),
    defineTool({
      name: 'write_file',
      description:
        'Create or overwrite a file. Path is relative to the working directory; parent dirs are created.',
      input: z.object({ path: z.string(), content: z.string() }),
      handler: async ({ path, content }) => {
        const abs = safePath(root, path)
        await mkdir(dirname(abs), { recursive: true })
        await writeFile(abs, content, 'utf8')
        return `Wrote ${content.length} bytes to ${path}`
      }
    })
  ]
}

/** Create the filesystem agent scoped to `dir`. */
export function filesystemAgent(dir: string): Agent {
  return createAgent({
    system: `You are a filesystem assistant working inside a single directory.
You have tools to explore and modify files: list_files, read_file, write_file.
Use them to accomplish the user's task, then briefly state what you did.`,
    tools: filesystemTools(dir),
    guardrails: { maxTurns: 25, maxCostUSD: 1.0 }
  })
}

/** Default export: the factory the CLI calls with parsed flags. */
export default (flags: Record<string, string> = {}): Agent =>
  filesystemAgent(flags.dir ?? process.cwd())

// Direct-run entrypoint: `npm run example:fs -- --dir <path> "<prompt>"`
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const dirIdx = args.indexOf('--dir')
  const dir = dirIdx >= 0 ? args[dirIdx + 1] : process.cwd()
  const prompt = args.filter((a, i) => a !== '--dir' && i !== dirIdx + 1).join(' ')
  if (!prompt) {
    process.stderr.write('Usage: npm run example:fs -- --dir <path> "<prompt>"\n')
    process.exit(1)
  }
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  printRun(filesystemAgent(dir), prompt).catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`)
    process.exit(1)
  })
}
