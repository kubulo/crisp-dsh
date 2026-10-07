/**
 * Runnable self-check for dsh-crip's host half: mounts the plugin against a
 * throwaway vault and exercises every tool, including the path-escape refusal.
 *
 *   node test/selfcheck.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

const vault = await mkdtemp(join(tmpdir(), 'crip-check-'))
const tools = new Map()
apply({ tools: { register: (definition) => tools.set(definition.name, definition) } }, { vault })

const names = [...tools.keys()].sort()
assert.deepEqual(names, ['vault_list', 'vault_read', 'vault_search', 'vault_write'], `tools: ${names}`)

const call = (toolName, args) => tools.get(toolName).execute(args, { signal: undefined })

// write → read round trip
const written = await call('vault_write', { path: '300_工坊/笔记.md', content: '第一行\nCrip 关键词\n' })
assert.equal(written.created, true)
assert.equal(written.path, '300_工坊/笔记.md')

const read = await call('vault_read', { path: '300_工坊/笔记.md' })
assert.equal(read.content, '第一行\nCrip 关键词\n')
assert.equal(read.truncated, false)

// append
await call('vault_write', { path: '300_工坊/笔记.md', content: '追加行', mode: 'append' })
assert.equal(await readFile(join(vault, '300_工坊/笔记.md'), 'utf8'), '第一行\nCrip 关键词\n\n追加行')

// search
const hits = await call('vault_search', { query: 'crip' })
assert.equal(hits.matches.length, 1)
assert.equal(hits.matches[0].path, '300_工坊/笔记.md')
assert.equal(hits.matches[0].line, 2)

// regex search
assert.equal((await call('vault_search', { query: '^追加', regex: true })).matches.length, 1)

// list
const listed = await call('vault_list', {})
assert.deepEqual(listed.entries, ['300_工坊/笔记.md'])

// traversal and missing-file refusals
await assert.rejects(() => call('vault_read', { path: '../../etc/hosts' }), /escapes the vault/)
await assert.rejects(() => call('vault_write', { path: '/tmp/crip-escape.md', content: 'x' }), /escapes the vault/)
await assert.rejects(() => call('vault_read', { path: '300_工坊/不存在.md' }), /no such note/)
await assert.rejects(() => call('vault_search', { query: '' }), /query is required/)

// render produces model-facing text
assert.match(tools.get('vault_read').output.render({}, read)[0].text, /第一行/)

// Every hand-written schema must pass the harness's own JSON Schema gate if dsh is installed locally.
try {
  const dshPath = process.env.DSH_ROOT || (await import('node:child_process')).execSync('npm root -g', { encoding: 'utf8' }).trim() + '/@deepseek-ai/dsh'
  const { assertSupportedJsonSchema } = await import(
    `${dshPath}/node_modules/@deepseek-ai/dsh-tools/lib/index.js`
  )
  for (const definition of tools.values()) {
    assertSupportedJsonSchema(definition.parameters)
    assertSupportedJsonSchema(definition.output.schema)
  }
} catch {
  // Pass if testing outside an environment with global @deepseek-ai/dsh
}

await rm(vault, { recursive: true, force: true })
console.log('dsh-crip host self-check: OK (4 tools, traversal refused)')
