/**
 * Host half of `dsh-crip` — the Obsidian vault face of DeepSeek Harness.
 *
 * Registers four model-facing tools scoped to one vault directory:
 * `vault_list`, `vault_read`, `vault_search`, `vault_write`. Every path is
 * resolved against the configured vault root and refused when it escapes, so
 * the model can never wander outside the notes it was pointed at.
 *
 * Zero runtime dependencies on purpose: the definitions below are plain JSON
 * Schema, so nothing has to resolve from this package's own `node_modules`.
 *
 * @module dsh-crip
 */

import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

export const name = 'dsh-crip'
export const inject = ['tools']

const DEFAULT_VAULT = process.env.DSH_CRIP_VAULT || process.cwd()
const SKIP_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules', '_assets'])
const MAX_READ_BYTES = 200_000
const MAX_SCAN_FILES = 5_000
const MAX_MATCHES = 80
const MAX_LIST = 400

const text = (value) => [{ type: 'text', text: value }]

/** Configured vault root; falls back to the env var, then to the shipped default. */
function vaultRoot(config) {
  const root = config?.vault ?? process.env.DSH_CRIP_VAULT ?? DEFAULT_VAULT
  return resolve(String(root))
}

/** Resolve a vault-relative note path, refusing anything outside the vault. */
function notePath(root, input) {
  const raw = String(input ?? '').trim()
  if (raw === '') throw new Error('path is required')
  const abs = resolve(root, raw)
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`path escapes the vault: ${raw}`)
  }
  return abs
}

/** Vault-relative, POSIX-shaped path for display. */
function displayPath(root, abs) {
  return relative(root, abs).split(sep).join('/')
}

function positiveInt(value, fallback, cap) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), cap)
}

/** Depth-first walk of vault notes, skipping noise directories and the cap. */
async function walkNotes(root, dirAbs, found, signal) {
  if (found.length >= MAX_SCAN_FILES || signal?.aborted) return
  let entries
  try {
    entries = await readdir(dirAbs, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (found.length >= MAX_SCAN_FILES || signal?.aborted) return
    if (entry.name.startsWith('.')) continue
    const abs = join(dirAbs, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await walkNotes(root, abs, found, signal)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      found.push(abs)
    }
  }
}

const PARAMETERS = {
  path: { type: 'string', description: 'Vault-relative path, for example `300_工坊/README.md`.' },
  dir: { type: 'string', description: 'Vault-relative directory to list. Omit for the vault root.' },
  query: { type: 'string', description: 'Substring to look for, case-insensitive unless `regex` is true.' },
  content: { type: 'string', description: 'Full note body to write.' },
  mode: { type: 'string', enum: ['overwrite', 'append'], description: 'Write mode; defaults to `overwrite`.' },
  limit: { type: 'integer', description: 'Maximum number of results to return.' },
  regex: { type: 'boolean', description: 'Treat `query` as a JavaScript regular expression.' },
}

const objectSchema = (properties, required) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
})

/**
 * Mount the vault tools.
 * @param ctx - host context.
 * @param config - bundle config; `vault` names the vault root.
 */
export function apply(ctx, config) {
  const root = vaultRoot(config)

  ctx.tools.register({
    name: 'vault_list',
    description: 'List Markdown notes in the Obsidian vault, optionally under one directory. '
      + 'Returns vault-relative paths. Use it to find a note before reading it.',
    parameters: objectSchema({ dir: PARAMETERS.dir, limit: PARAMETERS.limit }, []),
    output: {
      schema: objectSchema({
        root: { type: 'string' },
        entries: { type: 'array', items: { type: 'string' } },
        truncated: { type: 'boolean' },
      }, ['root', 'entries', 'truncated']),
      render: (_args, value) => text(
        value.entries.length === 0
          ? `No Markdown notes under ${value.root}`
          : `${value.entries.length} note(s) under ${value.root}${value.truncated ? ' (truncated)' : ''}:\n`
            + value.entries.join('\n'),
      ),
    },
    async execute(args, exec) {
      const base = args?.dir ? notePath(root, args.dir) : root
      const info = await stat(base).catch(() => undefined)
      if (!info) throw new Error(`no such directory in the vault: ${args?.dir ?? '.'}`)
      if (!info.isDirectory()) throw new Error(`not a directory: ${args.dir}`)
      const limit = positiveInt(args?.limit, MAX_LIST, MAX_LIST)
      const found = []
      await walkNotes(root, base, found, exec?.signal)
      return {
        root: displayPath(root, base) || '.',
        entries: found.slice(0, limit).map((abs) => displayPath(root, abs)),
        truncated: found.length > limit,
      }
    },
  })

  ctx.tools.register({
    name: 'vault_read',
    description: 'Read one Markdown note from the Obsidian vault by its vault-relative path.',
    parameters: objectSchema({ path: PARAMETERS.path, limit: PARAMETERS.limit }, ['path']),
    output: {
      schema: objectSchema({
        path: { type: 'string' },
        content: { type: 'string' },
        truncated: { type: 'boolean' },
      }, ['path', 'content', 'truncated']),
      render: (_args, value) => text(`${value.path}${value.truncated ? ' (truncated)' : ''}\n\n${value.content}`),
    },
    async execute(args) {
      const abs = notePath(root, args?.path)
      const info = await stat(abs).catch(() => undefined)
      if (!info) throw new Error(`no such note: ${args.path}`)
      if (!info.isFile()) throw new Error(`not a file: ${args.path}`)
      const cap = positiveInt(args?.limit, MAX_READ_BYTES, MAX_READ_BYTES)
      const body = await readFile(abs, 'utf8')
      return {
        path: displayPath(root, abs),
        content: body.length > cap ? body.slice(0, cap) : body,
        truncated: body.length > cap,
      }
    },
  })

  ctx.tools.register({
    name: 'vault_search',
    description: 'Search the text of every Markdown note in the Obsidian vault. '
      + 'Returns matching lines with their vault-relative path and line number.',
    parameters: objectSchema({
      query: PARAMETERS.query,
      regex: PARAMETERS.regex,
      limit: PARAMETERS.limit,
    }, ['query']),
    output: {
      schema: objectSchema({
        matches: {
          type: 'array',
          items: objectSchema({
            path: { type: 'string' },
            line: { type: 'integer' },
            text: { type: 'string' },
          }, ['path', 'line', 'text']),
        },
        truncated: { type: 'boolean' },
      }, ['matches', 'truncated']),
      render: (_args, value) => text(
        value.matches.length === 0
          ? 'No matches.'
          : value.matches
            .map((m) => `${m.path}:${m.line}: ${m.text}`)
            .join('\n') + (value.truncated ? '\n… (truncated)' : ''),
      ),
    },
    async execute(args, exec) {
      const needle = String(args?.query ?? '')
      if (needle === '') throw new Error('query is required')
      const limit = positiveInt(args?.limit, MAX_MATCHES, MAX_MATCHES)
      const pattern = args?.regex ? new RegExp(needle, 'i') : undefined
      const haystack = needle.toLowerCase()
      const notes = []
      await walkNotes(root, root, notes, exec?.signal)
      const matches = []
      for (const abs of notes) {
        if (matches.length >= limit || exec?.signal?.aborted) break
        let body
        try {
          body = await readFile(abs, 'utf8')
        } catch {
          continue
        }
        const lines = body.split('\n')
        for (let i = 0; i < lines.length && matches.length < limit; i += 1) {
          const line = lines[i]
          const hit = pattern ? pattern.test(line) : line.toLowerCase().includes(haystack)
          if (hit) {
            matches.push({
              path: displayPath(root, abs),
              line: i + 1,
              text: line.trim().slice(0, 300),
            })
          }
        }
      }
      return { matches, truncated: matches.length >= limit }
    },
  })

  ctx.tools.register({
    name: 'vault_write',
    description: 'Create or update one Markdown note in the Obsidian vault. '
      + 'Parent directories are created as needed; `append` adds to the end of an existing note.',
    parameters: objectSchema({
      path: PARAMETERS.path,
      content: PARAMETERS.content,
      mode: PARAMETERS.mode,
    }, ['path', 'content']),
    output: {
      schema: objectSchema({
        path: { type: 'string' },
        bytes: { type: 'integer' },
        created: { type: 'boolean' },
        mode: { type: 'string' },
      }, ['path', 'bytes', 'created', 'mode']),
      render: (_args, value) => text(
        `${value.created ? 'Created' : value.mode === 'append' ? 'Appended to' : 'Overwrote'} `
        + `${value.path} (${value.bytes} bytes)`,
      ),
    },
    async execute(args) {
      const abs = notePath(root, args?.path)
      if (typeof args?.content !== 'string') throw new Error('content must be a string')
      const mode = args?.mode === 'append' ? 'append' : 'overwrite'
      const existing = await stat(abs).catch(() => undefined)
      if (existing?.isDirectory()) throw new Error(`not a file: ${args.path}`)
      await mkdir(dirname(abs), { recursive: true })
      const body = mode === 'append' && existing ? `\n${args.content}` : args.content
      await writeFile(abs, body, mode === 'append' && existing ? { flag: 'a' } : 'utf8')
      return {
        path: displayPath(root, abs),
        bytes: Buffer.byteLength(body),
        created: existing === undefined,
        mode,
      }
    },
  })
}
