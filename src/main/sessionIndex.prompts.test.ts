import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  __resetSessionIndexCacheForTests,
  __sessionIndexCacheEntryForTests,
  __sessionIndexCacheSizeForTests,
  extractPromptsFromFile,
} from './sessionIndex.js'

// Incremental transcript reads for the session picker (#735). The contracts
// that MUST hold: a listing folds only the tail it needs, growth folds only
// the bytes appended since the last read, search extends to the head exactly
// once, and none of that changes WHICH prompts come back or in what order.

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'session-index-'))
  __resetSessionIndexCacheForTests()
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const T0 = 1_700_000_000_000

function claudeUser(text: string, i: number): string {
  return JSON.stringify({
    type: 'user',
    uuid: `u-${i}`,
    permissionMode: 'default',
    cwd: '/project',
    timestamp: new Date(T0 + i * 1000).toISOString(),
    message: { role: 'user', content: [{ type: 'text', text }] },
  }) + '\n'
}

function claudeFiller(i: number, bytes: number): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: `a-${i}`,
    cwd: '/project',
    message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(bytes) }] },
  }) + '\n'
}

function codexMeta(cwd: string): string {
  return JSON.stringify({ type: 'session_meta', payload: { id: 's', cwd } }) + '\n'
}

function codexUser(text: string, i: number): string {
  return JSON.stringify({
    type: 'event_msg',
    timestamp: new Date(T0 + i * 1000).toISOString(),
    payload: { type: 'user_message', message: text },
  }) + '\n'
}

function codexFiller(bytes: number): string {
  return JSON.stringify({
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'y'.repeat(bytes) }] },
  }) + '\n'
}

/** ~2 KB per turn × 300 turns ≈ 600 KB: comfortably more than one tail window. */
function writeLargeClaudeTranscript(file: string, turns = 300): void {
  let text = ''
  for (let i = 0; i < turns; i += 1) {
    text += claudeUser(`prompt ${i}`, i)
    text += claudeFiller(i, 2_000)
  }
  writeFileSync(file, text)
}

describe('extractPromptsFromFile', () => {
  it('lists the newest prompts from the tail without parsing from the head', async () => {
    const file = join(root, 'a.jsonl')
    writeLargeClaudeTranscript(file)

    const { prompts, cwd } = await extractPromptsFromFile('claude', 'a', file, 4)

    expect(prompts.slice(0, 4).map(p => p.text)).toEqual(['prompt 299', 'prompt 298', 'prompt 297', 'prompt 296'])
    expect(prompts[0]?.ts).toBe(T0 + 299 * 1000)
    expect(cwd).toBe('/project')
    const entry = __sessionIndexCacheEntryForTests('claude', 'a')!
    expect(entry.parsedFrom).toBeGreaterThan(0)
    expect(entry.prompts).toBeGreaterThanOrEqual(4)
    expect(entry.prompts).toBeLessThan(300)
  })

  it('folds only appended bytes on growth and leaves a partial trailing line for later', async () => {
    const file = join(root, 'b.jsonl')
    writeLargeClaudeTranscript(file)
    await extractPromptsFromFile('claude', 'b', file, 4)
    const before = __sessionIndexCacheEntryForTests('claude', 'b')!

    const partial = '{"type":"user","uuid":"u-partial","permissionMode":"default"'
    appendFileSync(file, claudeUser('prompt 300', 300) + claudeUser('prompt 301', 301) + partial)

    const grown = await extractPromptsFromFile('claude', 'b', file, 4)
    expect(grown.prompts.slice(0, 3).map(p => p.text)).toEqual(['prompt 301', 'prompt 300', 'prompt 299'])
    const after = __sessionIndexCacheEntryForTests('claude', 'b')!
    // The head of the parsed range did not move: nothing older was re-read.
    expect(after.parsedFrom).toBe(before.parsedFrom)
    expect(after.parsedTo).toBe(before.parsedTo + claudeUser('prompt 300', 300).length + claudeUser('prompt 301', 301).length)

    // Completing the line makes it visible on the next read.
    appendFileSync(file, ',"cwd":"/project","message":{"role":"user","content":[{"type":"text","text":"prompt 302"}]}}\n')
    const completed = await extractPromptsFromFile('claude', 'b', file, 4)
    expect(completed.prompts[0]?.text).toBe('prompt 302')
  })

  it('extends to the head once for search and stays incremental afterwards', async () => {
    const file = join(root, 'c.jsonl')
    writeLargeClaudeTranscript(file)
    await extractPromptsFromFile('claude', 'c', file, 4)

    const all = await extractPromptsFromFile('claude', 'c', file, 'all')
    expect(all.prompts).toHaveLength(300)
    expect(all.prompts.at(-1)?.text).toBe('prompt 0')
    expect(all.prompts[0]?.text).toBe('prompt 299')
    expect(__sessionIndexCacheEntryForTests('claude', 'c')!.parsedFrom).toBe(0)

    appendFileSync(file, claudeUser('prompt 300', 300))
    const again = await extractPromptsFromFile('claude', 'c', file, 'all')
    expect(again.prompts).toHaveLength(301)
    expect(again.prompts[0]?.text).toBe('prompt 300')
  })

  it('collapses an adjacent duplicate prompt across the tail-window seam, keeping the older one', async () => {
    const file = join(root, 'd.jsonl')
    // 'same' is recorded twice with 300 KB between the copies, so the first
    // 256 KiB tail read holds only the later copy and the backward extension
    // brings in the earlier one.
    writeFileSync(
      file,
      claudeUser('first', 0) +
        claudeUser('same', 1) +
        claudeFiller(1, 300 * 1024) +
        claudeUser('same', 2) +
        claudeUser('last', 3),
    )

    const all = await extractPromptsFromFile('claude', 'd', file, 'all')
    expect(all.prompts.map(p => p.text)).toEqual(['last', 'same', 'first'])
    // The surviving copy is the earlier record, as in a single-pass parse.
    expect(all.prompts[1]?.ts).toBe(T0 + 1 * 1000)
  })

  it('reads the Codex cwd from the session_meta at the head when the tail lacks it', async () => {
    const file = join(root, 'rollout-x.jsonl')
    writeFileSync(
      file,
      codexMeta('/codex-project') +
        codexFiller(300 * 1024) +
        codexUser('codex prompt 1', 1) +
        codexUser('codex prompt 2', 2),
    )

    const { prompts, cwd } = await extractPromptsFromFile('codex', 'x', file, 2)
    expect(prompts.map(p => p.text)).toEqual(['codex prompt 2', 'codex prompt 1'])
    expect(cwd).toBe('/codex-project')
    expect(__sessionIndexCacheEntryForTests('codex', 'x')!.parsedFrom).toBeGreaterThan(0)
  })

  it('re-parses from scratch when the file was rewritten shorter', async () => {
    const file = join(root, 'e.jsonl')
    writeLargeClaudeTranscript(file)
    await extractPromptsFromFile('claude', 'e', file, 'all')

    writeFileSync(file, claudeUser('fresh 0', 0) + claudeUser('fresh 1', 1))
    const { prompts } = await extractPromptsFromFile('claude', 'e', file, 'all')
    expect(prompts.map(p => p.text)).toEqual(['fresh 1', 'fresh 0'])
    expect(__sessionIndexCacheEntryForTests('claude', 'e')!.parsedFrom).toBe(0)
  })

  it('returns nothing for a missing file and keeps the cache bounded', async () => {
    const missing = await extractPromptsFromFile('claude', 'nope', join(root, 'nope.jsonl'), 4)
    expect(missing).toEqual({ prompts: [], cwd: '' })

    for (let i = 0; i < 520; i += 1) {
      const file = join(root, `tiny-${i}.jsonl`)
      writeFileSync(file, claudeUser(`tiny ${i}`, i))
      await extractPromptsFromFile('claude', `tiny-${i}`, file, 4)
    }
    expect(__sessionIndexCacheSizeForTests()).toBeLessThanOrEqual(512)
    // The most recently used entry survives eviction; the oldest did not.
    expect(__sessionIndexCacheEntryForTests('claude', 'tiny-519')).not.toBeNull()
    expect(__sessionIndexCacheEntryForTests('claude', 'tiny-0')).toBeNull()
  })
})
