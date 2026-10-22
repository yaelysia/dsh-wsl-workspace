/**
 * WSL read with the host tool's exact schema, window and presentation semantics.
 * The only changed execution step is resolve/stat/readText -> fs.readSnapshot.
 * Source behavior: @deepseek-ai/dsh-tool-fs (MIT; see NOTICE).
 */
import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget } from '@deepseek-ai/dsh-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution, ToolResult } from '@deepseek-ai/dsh-tools'
import { readLangHintForPath } from '@deepseek-ai/dsh-util-code-language'
import z from '@deepseek-ai/schemastery'

export const inject = ['tools', 'fs', 'systemPrompt', 'workingDirectory']
export interface Config {
  readLimit?: number
  readMaxLineLength?: number
  readMaxBytes?: number
  readStreamMinSize?: number
}
export const Config: z<Config> = z.object({
  readLimit: z.number().default(2000),
  readMaxLineLength: z.number().default(2000),
  readMaxBytes: z.number().default(50 * 1024),
  readStreamMinSize: z.number().default(10 * 1024 * 1024),
})

interface ReadInfo { target: FsTarget; info: FsInfo | undefined; text?: string }
interface FsFace {
  readSnapshot(path: string, options: { cwd?: string; signal?: AbortSignal; streamMinSize: number }): Promise<ReadInfo>
  streamText(target: FsTarget, signal?: AbortSignal): Promise<AsyncIterable<string>>
  processPath(target: FsTarget): string
}
interface WorkingDirectory { ensure(agent: NonNullable<ToolExecution['agent']>, signal?: AbortSignal): Promise<string | undefined> }
interface Line { number: number; text: string }
interface ReadValue { path: string; offset: number; lines: Line[]; totalLines: number }
interface ReadMeta extends ReadValue { lang?: string }

function readArgs(args: { file_path: string; offset?: number; limit?: number }, maxLimit: number) {
  if (args.file_path.trim().length === 0) throw new Error('file_path must be a non-empty string')
  const positive = (value: number, label: string) => {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`)
    return value
  }
  const offset = args.offset === undefined ? 1 : positive(args.offset, 'offset')
  const limit = args.limit === undefined ? maxLimit : positive(args.limit, 'limit')
  if (limit > maxLimit) throw new Error(`limit must be less than or equal to ${maxLimit}`)
  return { filePath: args.file_path, offset, limit }
}

/** Mirrors the bounded, exact-total-line host window, including CRLF and long-line limits. */
async function windowOf(chunks: AsyncIterable<string> | Iterable<string>,
  request: { offset: number; limit: number; maxLineLength: number; maxBytes: number }, path: string) {
  const lines: Line[] = []
  let totalLines = 0, outputBytes = 0, truncatedByBytes = false, lineBuffer = ''
  const bufferCap = request.maxLineLength + 1
  const append = (segment: string) => {
    if (lineBuffer.length < bufferCap) lineBuffer = (lineBuffer + segment).slice(0, bufferCap)
  }
  const flush = () => {
    totalLines++
    if (!truncatedByBytes && totalLines >= request.offset && lines.length < request.limit) {
      const line = lineBuffer.endsWith('\r') ? lineBuffer.slice(0, -1) : lineBuffer
      const text = line.length > request.maxLineLength
        ? `${line.substring(0, request.maxLineLength)}... (line truncated to ${request.maxLineLength} chars)` : line
      const bytes = Buffer.byteLength(text, 'utf8') + (lines.length ? 1 : 0)
      if (outputBytes + bytes > request.maxBytes) truncatedByBytes = true
      else { outputBytes += bytes; lines.push({ number: totalLines, text }) }
    }
    lineBuffer = ''
  }
  for await (const chunk of chunks) {
    let begin = 0, end: number
    while ((end = chunk.indexOf('\n', begin)) !== -1) {
      append(chunk.slice(begin, end))
      flush()
      begin = end + 1
    }
    append(chunk.slice(begin))
  }
  if (lineBuffer.length) flush()
  if (!truncatedByBytes && request.offset > totalLines && !(totalLines === 0 && request.offset === 1)) {
    throw new FsError(`offset ${request.offset} is out of range for "${path}" (${totalLines} lines)`, 'FS_NOT_FOUND')
  }
  return { lines, totalLines, truncatedByBytes }
}

function formattedRead(value: ReadValue, truncatedByBytes: boolean): string {
  const end = value.lines.at(-1)?.number ?? Math.max(0, value.offset - 1)
  const footer = truncatedByBytes
    ? `(Output capped. Showing lines ${value.offset}-${end}. Use offset=${end + 1} to continue.)`
    : end < value.totalLines
      ? `(Showing lines ${value.offset}-${end} of ${value.totalLines}. Use offset=${end + 1} to continue.)`
      : `(End of file - total ${value.totalLines} lines)`
  const body = value.lines.length ? `${value.lines.map(line => `${line.number}: ${line.text}`).join('\n')}\n\n${footer}` : footer
  return `<path>${value.path}</path>\n<type>file</type>\n<content>\n${body}\n</content>`
}

function readMeta(meta: unknown): ReadMeta | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const { path, offset, lines, totalLines, lang } = meta as Record<string, unknown>
  if (typeof path !== 'string' || !Number.isInteger(offset) || (offset as number) < 1
    || !Number.isInteger(totalLines) || (totalLines as number) < 0
    || !Array.isArray(lines) || (lang !== undefined && typeof lang !== 'string')) return undefined
  let previous = (offset as number) - 1
  for (const line of lines) {
    if (!line || typeof line !== 'object' || !Number.isInteger(line.number) || line.number <= previous
      || line.number > (totalLines as number) || typeof line.text !== 'string') return undefined
    previous = line.number
  }
  return { path, offset: offset as number, lines: lines as Line[], totalLines: totalLines as number,
    ...lang === undefined ? {} : { lang: lang as string } }
}

export function apply(ctx: Context, config: Config = {}): void {
  const caps = { readLimit: 2000, readMaxLineLength: 2000, readMaxBytes: 50 * 1024,
    readStreamMinSize: 10 * 1024 * 1024, ...config }
  for (const [key, value] of Object.entries(caps)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`wsl-read: invalid ${key}`)
  }
  const tools = ctx.get('tools') as unknown as { register(tool: unknown): void } | undefined
  if (tools === undefined) return
  const prompt = ctx.get('systemPrompt') as unknown as {
    section(value: unknown): void; getSectionOrder(name: string): number
  } | undefined
  prompt?.section({
    name: 'tool:read', order: prompt.getSectionOrder('TOOL_READ'),
    text: ({ scope }: { scope: unknown }) => {
      const getter = ctx.get('tools') as unknown as { get?(name: string, scope: unknown): unknown } | undefined
      return getter?.get?.('read', scope) === undefined ? ''
        : 'Use the read tool — not shell commands like cat — to inspect text files. Use offset and limit to continue reading large files.'
    },
  })

  tools.register(defineTool({
    name: 'read',
    description: 'Read a UTF-8 text file and return line-numbered content.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to read, resolved by the filesystem backend.' },
      offset: { type: 'number', description: '1-based first line to return. Defaults to 1.' },
      limit: { type: 'number', description: `Maximum number of lines to return. Defaults to ${caps.readLimit}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          offset: { type: 'integer', required: true },
          lines: { type: 'array', required: true, items: {
            type: 'object', additionalProperties: false, properties: {
              number: { type: 'integer', required: true }, text: { type: 'string', required: true },
            },
          } },
          totalLines: { type: 'integer', required: true },
        },
      },
      render: (args, value: ReadValue) => {
        const input = readArgs(args, caps.readLimit)
        const end = value.lines.at(-1)?.number ?? Math.max(0, value.offset - 1)
        return [{ type: 'text', text: formattedRead(value,
          value.lines.length < input.limit && end < value.totalLines) }]
      },
      presentationMeta: (_args, value: ReadValue) => {
        const lang = readLangHintForPath(value.path)
        return { ...value, ...lang === undefined ? {} : { lang } }
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec: ToolExecution): Promise<ReadValue> {
      const input = readArgs(args, caps.readLimit)
      const fs = ctx.get('fs') as unknown as FsFace | undefined
      if (fs === undefined) throw new Error('wsl-read: this world has no filesystem service')
      const directory = ctx.get('workingDirectory') as unknown as WorkingDirectory | undefined
      const cwd = exec.agent === undefined ? undefined : await directory?.ensure(exec.agent, exec.signal)
      const snapshot = await fs.readSnapshot(input.filePath, {
        ...cwd === undefined ? {} : { cwd },
        signal: exec.signal, streamMinSize: caps.readStreamMinSize,
      })
      const { target, info } = snapshot
      if (!info) {
        ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
        throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
      }
      if (info.type !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
      const chunks = info.size === undefined || info.size >= caps.readStreamMinSize
        ? await fs.streamText(target, exec.signal) : [snapshot.text!]
      const window = await windowOf(chunks, {
        offset: input.offset, limit: input.limit,
        maxLineLength: caps.readMaxLineLength, maxBytes: caps.readMaxBytes,
      }, target.displayPath)
      const value = { path: fs.processPath(target), offset: input.offset,
        lines: window.lines, totalLines: window.totalLines }
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
      return value
    },
    presentResult(_args, result: ToolResult) {
      if (result.isError) return undefined
      const meta = readMeta(result.meta)
      if (!meta) return undefined
      const text = result.content.length === 1 && result.content[0]?.type === 'text'
        ? result.content[0].text : undefined
      const body = text === undefined ? undefined
        : /^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u.exec(text)?.[1]
      if (body === undefined) return undefined
      return { card: 'read' as const, path: meta.path, offset: meta.offset,
        lines: meta.lines, totalLines: meta.totalLines,
        ...meta.lang === undefined ? {} : { lang: meta.lang },
        content: [{ type: 'text' as const, text: body }] }
    },
    presentCall(args) {
      const { offset, limit } = args
      const suffix = limit !== undefined && limit > 0
        ? ` (${offset ?? 1} - ${(offset ?? 1) + limit - 1})`
        : offset !== undefined ? ` (from line ${offset})` : ''
      return { card: 'generic' as const, title: `Read ${args.file_path}${suffix}`,
        kind: 'read' as const, locations: [{ path: args.file_path, line: offset ?? 1 }] }
    },
  }))
}
export default { apply, inject, Config }
