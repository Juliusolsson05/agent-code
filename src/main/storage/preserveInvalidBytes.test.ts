import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { preserveInvalidBytes } from './preserveInvalidBytes.js'

// The shared evidence writer for the fail-all store family (#1245-#1249,
// #1260 review B). Every property here is one a store relies on to call a
// damaged row "set aside" rather than "deleted".
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function prefixIn(): Promise<{ root: string; prefix: string }> {
  const root = await mkdtemp(join(tmpdir(), 'agent-code-preserve-'))
  roots.push(root)
  return { root, prefix: join(root, 'store.json.invalid') }
}
const digestOf = (bytes: string) => createHash('sha256').update(bytes).digest('hex').slice(0, 16)

it('writes the exact bytes once, privately, under a digest name, and leaves no temp file', async () => {
  const { root, prefix } = await prefixIn()
  const bytes = '{"damaged": true}'
  const first = await preserveInvalidBytes(prefix, bytes)
  const second = await preserveInvalidBytes(prefix, bytes)
  expect(first).toBe(`${prefix}-${digestOf(bytes)}.json`)
  expect(second).toBe(first)
  expect(await readFile(first, 'utf8')).toBe(bytes)
  expect((await stat(first)).mode & 0o777).toBe(0o600)
  expect(await readdir(root)).toEqual([`store.json.invalid-${digestOf(bytes)}.json`])
})

it('never trusts a different file under its name: it forks a fresh copy and leaves the other alone', async () => {
  // A crash mid-write, or anything else, can leave other bytes under the
  // final name; treating "the name exists" as proof lost the evidence.
  const { prefix } = await prefixIn()
  const bytes = '{"damaged": true}'
  const occupied = `${prefix}-${digestOf(bytes)}.json`
  await writeFile(occupied, '')
  const copy = await preserveInvalidBytes(prefix, bytes)
  expect(copy).not.toBe(occupied)
  expect(await readFile(copy, 'utf8')).toBe(bytes)
  expect(await readFile(occupied, 'utf8')).toBe('')
})

it('honours an explicit extension, including none', async () => {
  const { prefix } = await prefixIn()
  expect(await preserveInvalidBytes(prefix, 'x', '')).toBe(`${prefix}-${digestOf('x')}`)
})

it('leaves no temp file behind when it cannot publish the copy', async () => {
  const { root, prefix } = await prefixIn()
  const bytes = '{"damaged": true}'
  // The final name is taken by something a rename cannot replace.
  const { mkdir } = await import('node:fs/promises')
  await mkdir(`${prefix}-${digestOf(bytes)}.json`)
  await expect(preserveInvalidBytes(prefix, bytes)).rejects.toThrow()
  expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
})
