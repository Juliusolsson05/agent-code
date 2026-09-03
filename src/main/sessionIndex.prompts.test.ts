import { appendFileSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
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
    // The head of the parsed range did not move: nothing older was re-read,
    // and the bytes actually read are the appended bytes plus the 64-byte
    // seam check.
    expect(after.parsedFrom).toBe(before.parsedFrom)
    expect(after.lastBytesRead).toBe(
      64 + claudeUser('prompt 300', 300).length + claudeUser('prompt 301', 301).length + partial.length,
    )
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

  it('returns nothing for a missing file and keeps the cache bounded as an LRU', async () => {
    const missing = await extractPromptsFromFile('claude', 'nope', join(root, 'nope.jsonl'), 4)
    expect(missing).toEqual({ prompts: [], cwd: '' })

    const total = 1_040
    for (let i = 0; i < total; i += 1) {
      const file = join(root, `tiny-${i}.jsonl`)
      writeFileSync(file, claudeUser(`tiny ${i}`, i))
      await extractPromptsFromFile('claude', `tiny-${i}`, file, 4)
      // Touch the very first entry late in the run: an LRU keeps it, a FIFO
      // would not.
      if (i === total - 8) await extractPromptsFromFile('claude', 'tiny-0', join(root, 'tiny-0.jsonl'), 4)
    }
    expect(__sessionIndexCacheSizeForTests()).toBeLessThanOrEqual(1024)
    expect(__sessionIndexCacheEntryForTests('claude', `tiny-${total - 1}`)).not.toBeNull()
    expect(__sessionIndexCacheEntryForTests('claude', 'tiny-0')).not.toBeNull()
    expect(__sessionIndexCacheEntryForTests('claude', 'tiny-1')).toBeNull()
  })

  it('serialises overlapping extractions of the same transcript', async () => {
    const file = join(root, 'f.jsonl')
    writeLargeClaudeTranscript(file)
    await extractPromptsFromFile('claude', 'f', file, 4)

    // Two full reads racing on a warm entry used to both fold the same chunk.
    const [a, b] = await Promise.all([
      extractPromptsFromFile('claude', 'f', file, 'all'),
      extractPromptsFromFile('claude', 'f', file, 'all'),
    ])
    expect(a.prompts).toHaveLength(300)
    expect(b.prompts).toHaveLength(300)
    expect(new Set(a.prompts.map(p => p.text)).size).toBe(300)

    appendFileSync(file, claudeUser('prompt 300', 300))
    const [c, d] = await Promise.all([
      extractPromptsFromFile('claude', 'f', file, 4),
      extractPromptsFromFile('claude', 'f', file, 4),
    ])
    expect(c.prompts.slice(0, 2).map(p => p.text)).toEqual(['prompt 300', 'prompt 299'])
    expect(d.prompts.slice(0, 2).map(p => p.text)).toEqual(['prompt 300', 'prompt 299'])
    expect(__sessionIndexCacheEntryForTests('claude', 'f')!.parsedTo).toBe(statSync(file).size)
  })

  it('folds a record far longer than the tail window without quadratic re-reads', async () => {
    const file = join(root, 'g.jsonl')
    // Two prompts, then an 8 MB record (a pasted image is exactly this shape).
    writeFileSync(file, claudeUser('before', 0) + claudeUser('also before', 1) + claudeFiller(2, 8 * 1024 * 1024))

    const { prompts } = await extractPromptsFromFile('claude', 'g', file, 2)
    expect(prompts.map(p => p.text)).toEqual(['also before', 'before'])
    // Geometric widening: the total bytes read stay within a small multiple
    // of the file size instead of re-reading the prefix per step.
    expect(__sessionIndexCacheEntryForTests('claude', 'g')!.lastBytesRead).toBeLessThan(3 * statSync(file).size)
  })

  it('re-parses when the mtime moved with the size unchanged', async () => {
    const file = join(root, 'h.jsonl')
    writeFileSync(file, claudeUser('one', 0) + claudeUser('two', 1))
    expect((await extractPromptsFromFile('claude', 'h', file, 'all')).prompts.map(p => p.text)).toEqual(['two', 'one'])

    // Same byte length, different content, mtime pushed forward explicitly so
    // the check does not depend on filesystem timestamp granularity.
    writeFileSync(file, claudeUser('uno', 0) + claudeUser('dos', 1))
    const later = new Date(statSync(file).mtimeMs + 5_000)
    utimesSync(file, later, later)
    expect((await extractPromptsFromFile('claude', 'h', file, 'all')).prompts.map(p => p.text)).toEqual(['dos', 'uno'])
  })

  it('detects a rewrite that grew the file instead of folding it on stale prompts', async () => {
    const file = join(root, 'i.jsonl')
    writeFileSync(file, claudeUser('old 0', 0) + claudeUser('old 1', 1))
    await extractPromptsFromFile('claude', 'i', file, 'all')

    let rewritten = ''
    for (let i = 0; i < 8; i += 1) rewritten += claudeUser(`new ${i}`, i)
    writeFileSync(file, rewritten)
    const { prompts } = await extractPromptsFromFile('claude', 'i', file, 'all')
    expect(prompts.map(p => p.text)).toEqual(['new 7', 'new 6', 'new 5', 'new 4', 'new 3', 'new 2', 'new 1', 'new 0'])
  })

  it('handles an empty file, a lone partial line, and a multi-byte seam', async () => {
    const empty = join(root, 'empty.jsonl')
    writeFileSync(empty, '')
    expect(await extractPromptsFromFile('claude', 'empty', empty, 4)).toEqual({ prompts: [], cwd: '' })

    const partial = join(root, 'partial.jsonl')
    writeFileSync(partial, '{"type":"user","uuid":"u"')
    expect(await extractPromptsFromFile('claude', 'partial', partial, 4)).toEqual({ prompts: [], cwd: '' })

    // A 300 KB filler after an emoji-heavy prompt puts the first tail window
    // boundary inside multi-byte sequences; cutting on newline BYTES and
    // decoding each chunk separately must still yield the prompt intact.
    const seam = join(root, 'seam.jsonl')
    const emoji = '🙂'.repeat(1_000)
    writeFileSync(seam, claudeUser(`first ${emoji}`, 0) + claudeFiller(1, 300 * 1024) + claudeUser('last', 2))
    const { prompts } = await extractPromptsFromFile('claude', 'seam', seam, 'all')
    expect(prompts.map(p => p.text)).toEqual(['last', `first ${emoji}`])
  })
})
