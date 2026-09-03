import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { streamJsonl } from '@shared/runtime/streamJsonl.js'

import {
  __readInitialTranscriptTailForTests as readTail,
  __readOlderTranscriptWindowForTests as readOlder,
  loadInitialHistoryChunkFromFile,
  loadOlderHistoryChunkFromFile,
} from './historyLoader.js'

// Reverse tail reads for history loading (#747). The contract that MUST
// hold: the window a reverse read returns is byte-for-byte what the full
// forward parse returned — same records, same order, same `hasMore`, same
// `totalEntries` — while the bytes read for it are bounded by the window,
// not the file. The oracle below IS the removed forward implementation
// (streamJsonl + ring buffer / marker scan), so every equivalence assertion
// compares against the behaviour the app shipped with, not against a
// re-derivation of it.

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'history-loader-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

type Entry = Record<string, unknown>

async function oracleTail(file: string, limit: number) {
  const entries: Entry[] = []
  let parsed = 0
  let parseErrors = 0
  for await (const raw of streamJsonl<Entry>(file)) {
    if (raw === null) {
      parseErrors += 1
      continue
    }
    parsed += 1
    entries.push(raw)
    if (entries.length > limit) entries.shift()
  }
  return { entries, parsed, parseErrors, hasMore: parsed > limit }
}

function claudeMarker(entry: Entry): string | null {
  return typeof entry.uuid === 'string' ? entry.uuid : null
}

function codexMarker(entry: Entry): string {
  const payload = entry.payload as Entry | undefined
  return `${String(entry.timestamp ?? '')}:${String(payload?.id ?? payload?.call_id ?? payload?.type ?? entry.type)}`
}

async function oracleOlder(file: string, kind: 'claude' | 'codex', marker: string, limit: number) {
  const markerOf = kind === 'claude' ? claudeMarker : codexMarker
  const entries: Entry[] = []
  let before = 0
  let found = false
  for await (const raw of streamJsonl<Entry>(file)) {
    if (raw === null) continue
    if (markerOf(raw) === marker) {
      found = true
      break
    }
    before += 1
    entries.push(raw)
    if (entries.length > limit) entries.shift()
  }
  return { entries, foundMarker: found, hasMore: before > limit }
}

function claudeLine(i: number, text: string): string {
  return JSON.stringify({
    type: i % 2 === 0 ? 'user' : 'assistant',
    uuid: `u-${i}`,
    seq: i,
    cwd: '/project/agent-code',
    sessionId: 'session-1',
    timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    message: { role: i % 2 === 0 ? 'user' : 'assistant', content: [{ type: 'text', text }] },
  }) + '\n'
}

function codexLine(i: number): string {
  return JSON.stringify({
    type: 'response_item',
    seq: i,
    timestamp: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    payload: { type: 'message', id: `msg-${i}`, role: 'assistant', content: `codex ${i}` },
  }) + '\n'
}

function writeClaude(name: string, count: number, text: (i: number) => string = i => `turn ${i}`): string {
  const file = join(root, name)
  let body = ''
  for (let i = 0; i < count; i += 1) body += claudeLine(i, text(i))
  writeFileSync(file, body)
  return file
}

function seqs(entries: Entry[]): number[] {
  return entries.map(e => e.seq as number)
}

describe('readInitialTranscriptTail', () => {
  it('returns the same window, count and hasMore as the full forward parse', async () => {
    const file = writeClaude('small.jsonl', 50)
    for (const limit of [1, 10, 49, 50, 51, 120]) {
      const got = await readTail(file, limit)
      const want = await oracleTail(file, limit)
      expect(got.entries, `limit ${limit}`).toEqual(want.entries)
      expect(got.parsed, `limit ${limit}`).toBe(want.parsed)
      expect(got.parsed > limit, `limit ${limit}`).toBe(want.hasMore)
      expect(got.parseErrors).toBe(0)
    }
  })

  it('matches the forward parse when records span blocks and a multi-byte character straddles a block boundary', async () => {
    // Records of wildly different sizes, all carrying non-ASCII text, so
    // block boundaries land inside records, inside multi-byte sequences,
    // and inside a record many times larger than a block.
    const file = writeClaude('blocks.jsonl', 400, i => {
      if (i === 350) return `image-ish ${'\u{1F5BC}'.repeat(80_000)}`
      if (i % 7 === 0) return `long ${'日本語テキスト'.repeat(1_500)} ${i}`
      return `short 🚀 ${i} — «très» ünïcode`
    })
    const bytes = readFileSync(file)
    // Pick the block size so that the FIRST boundary counted back from EOF
    // (size - blockBytes) falls in the middle of a 4-byte emoji near the
    // tail: the rocket in record 398.
    const marker = Buffer.from(`short 🚀 398`)
    const rocketAt = bytes.indexOf(marker) + Buffer.byteLength('short ')
    expect(bytes.subarray(rocketAt, rocketAt + 4).toString('utf8')).toBe('🚀')
    const blockBytes = bytes.length - (rocketAt + 2)
    expect(bytes.length - blockBytes).toBeGreaterThan(rocketAt)
    expect(bytes.length - blockBytes).toBeLessThan(rocketAt + 4)
    // The 320 KB record sits well inside the window and spans many blocks
    // of this size (record 399 is a ~30 KB "long" one, so the derived block
    // is ~30 KB).
    expect(Buffer.byteLength(claudeLine(350, `image-ish ${'\u{1F5BC}'.repeat(80_000)}`))).toBeGreaterThan(blockBytes * 8)

    for (const limit of [3, 60, 120]) {
      const got = await readTail(file, limit, blockBytes)
      const want = await oracleTail(file, limit)
      expect(got.entries, `limit ${limit}`).toEqual(want.entries)
      expect(got.parsed, `limit ${limit}`).toBe(want.parsed)
      expect(got.parseErrors).toBe(0)
    }
    // And with the production block size, which lands boundaries elsewhere.
    const got = await readTail(file, 120)
    expect(got.entries).toEqual((await oracleTail(file, 120)).entries)
  })

  it('reads bytes proportional to the window, not the file, and still counts the whole file', async () => {
    // ~4 MB of ~10 KB records. The window is the last 11 records
    // (limit + 1 for hasMore) — well under 200 KB.
    const file = writeClaude('large.jsonl', 400, i => `${'x'.repeat(10_000)} ${i}`)
    const size = readFileSync(file).length
    expect(size).toBeGreaterThan(3_500_000)
    const blockBytes = 64 * 1024
    const got = await readTail(file, 10, blockBytes)
    const windowBytes = Array.from({ length: 11 }, (_, k) =>
      Buffer.byteLength(claudeLine(399 - k, `${'x'.repeat(10_000)} ${399 - k}`)),
    ).reduce((a, b) => a + b, 0)
    expect(got.tailBytes).toBeLessThanOrEqual(windowBytes + blockBytes)
    expect(got.tailBytes).toBeLessThan(size / 8)
    expect(seqs(got.entries)).toEqual([390, 391, 392, 393, 394, 395, 396, 397, 398, 399])
    // totalEntries covers the untouched head too.
    expect(got.parsed).toBe(400)
    expect(got.bytes).toBe(size)
  })

  it('returns every record with hasMore=false when the window is larger than the file', async () => {
    const file = writeClaude('short.jsonl', 20)
    const chunk = await loadInitialHistoryChunkFromFile(file, 500)
    expect(seqs(chunk.entries)).toEqual(Array.from({ length: 20 }, (_, i) => i))
    expect(chunk.hasMore).toBe(false)
    expect(chunk.totalEntries).toBe(20)
    // A window that is exactly the file: still everything, still no more.
    const exact = await loadInitialHistoryChunkFromFile(file, 20)
    expect(exact.entries).toHaveLength(20)
    expect(exact.hasMore).toBe(false)
    expect(exact.totalEntries).toBe(20)
  })

  it('treats blank, malformed, literal-null and unterminated lines exactly like the forward parse', async () => {
    const file = join(root, 'junk.jsonl')
    writeFileSync(
      file,
      claudeLine(0, 'a') +
        '\n' +
        claudeLine(1, 'b') +
        '{"type":"user","seq":2,"uuid":"u-2"' + '\n' + // truncated record
        '   \r\n' +
        claudeLine(3, 'c') +
        'null\n' +
        claudeLine(4, 'd').trimEnd() + '\r\n' + // CRLF-terminated
        claudeLine(5, 'e') +
        '{"type":"assistant","seq":6,"uuid":"u-6","partial":tru', // mid-append, no newline
    )
    // Five usable records (0, 1, 3, 4, 5) and three parse errors.
    expect(await oracleTail(file, 10)).toMatchObject({ parsed: 5, parseErrors: 3 })
    for (const limit of [1, 2, 4, 10]) {
      const got = await readTail(file, limit, 48)
      const want = await oracleTail(file, limit)
      expect(got.entries, `limit ${limit}`).toEqual(want.entries)
      expect(got.parsed > limit, `limit ${limit}`).toBe(want.hasMore)
    }
    // A window that walks the whole file counts exactly what the forward
    // parse counted, junk included.
    expect(await readTail(file, 10, 48)).toMatchObject({ parsed: 5, parseErrors: 3 })
    expect(seqs((await readTail(file, 10, 48)).entries)).toEqual([0, 1, 3, 4, 5])
    // DOCUMENTED DEVIATION: a window that stops before the junk counts the
    // untouched head by newlines without parsing it, so the blank line, the
    // truncated record and the blank CR line before record 3 are counted as
    // if they were records (8 instead of 5), and only the tail's parse
    // errors (the mid-append line and the literal null) are reported.
    // Provider-written transcripts never have junk in
    // their head (the only malformed line is the mid-append one at EOF), so
    // this only ever shows on a hand-edited file; a full parse to make the
    // count exact there is the cost #747 removed. Change this assertion
    // knowingly if that trade-off is ever revisited.
    expect(await readTail(file, 2, 48)).toMatchObject({ parsed: 8, parseErrors: 2 })
  })

  it('returns an empty chunk for an empty file, a junk-only file and a missing file', async () => {
    const empty = join(root, 'empty.jsonl')
    writeFileSync(empty, '')
    const junk = join(root, 'junk-only.jsonl')
    writeFileSync(junk, '\n\nnot json\n{\n')
    const missing = join(root, 'missing.jsonl')
    for (const file of [empty, junk, missing]) {
      expect(await loadInitialHistoryChunkFromFile(file, 120), file).toEqual({
        entries: [],
        hasMore: false,
        totalEntries: 0,
      })
    }
  })
})

describe('readOlderTranscriptWindow', () => {
  it('pages older history identically to the forward marker scan at every depth', async () => {
    const file = writeClaude('pages.jsonl', 300)
    for (const [anchor, limit] of [[299, 50], [280, 50], [150, 200], [37, 10], [1, 50], [0, 50]] as const) {
      const got = await readOlder(file, { kind: 'claude', beforeMarker: `u-${anchor}`, limit }, 4096)
      const want = await oracleOlder(file, 'claude', `u-${anchor}`, limit)
      expect(got.entries, `anchor ${anchor}`).toEqual(want.entries)
      expect(got.hasMore, `anchor ${anchor}`).toBe(want.hasMore)
      expect(got.foundMarker, `anchor ${anchor}`).toBe(true)
    }
    // The public entrypoint shapes the "nothing before the first record"
    // case as the end of pagination.
    expect(await loadOlderHistoryChunkFromFile(file, { kind: 'claude', beforeMarker: 'u-0', limit: 50 }))
      .toEqual({ entries: [], hasMore: false })
  })

  it('resolves Codex markers from timestamp + payload id like the forward scan', async () => {
    const file = join(root, 'codex.jsonl')
    let body = ''
    for (let i = 0; i < 40; i += 1) body += codexLine(i)
    writeFileSync(file, body)
    const anchor = codexMarker(JSON.parse(codexLine(30)) as Entry)
    const got = await readOlder(file, { kind: 'codex', beforeMarker: anchor, limit: 5 }, 512)
    const want = await oracleOlder(file, 'codex', anchor, 5)
    expect(seqs(got.entries)).toEqual([25, 26, 27, 28, 29])
    expect(got.entries).toEqual(want.entries)
    expect(got.hasMore).toBe(true)
  })

  it('falls back to the file tail when the marker is missing, as the forward scan did', async () => {
    const file = writeClaude('missing-marker.jsonl', 30)
    for (const limit of [5, 30, 40]) {
      const got = await readOlder(file, { kind: 'claude', beforeMarker: 'never-written', limit }, 1024)
      const want = await oracleOlder(file, 'claude', 'never-written', limit)
      expect(got.foundMarker).toBe(false)
      expect(got.entries, `limit ${limit}`).toEqual(want.entries)
      expect(got.hasMore, `limit ${limit}`).toBe(want.hasMore)
    }
  })

  it('reads from EOF to the anchor, not from the head of the file', async () => {
    const file = writeClaude('deep.jsonl', 400, i => `${'y'.repeat(10_000)} ${i}`)
    const size = readFileSync(file).length
    const blockBytes = 64 * 1024
    // Anchor 20 records from the end, page of 10: the read must cover the
    // 20 records after the anchor, the anchor, and 11 before it — 32
    // records, ~320 KB of a ~4 MB file.
    const got = await readOlder(file, { kind: 'claude', beforeMarker: 'u-380', limit: 10 }, blockBytes)
    expect(seqs(got.entries)).toEqual([370, 371, 372, 373, 374, 375, 376, 377, 378, 379])
    expect(got.hasMore).toBe(true)
    const recordBytes = Buffer.byteLength(claudeLine(380, `${'y'.repeat(10_000)} 380`))
    expect(got.tailBytes).toBeLessThanOrEqual(32 * recordBytes + blockBytes)
    expect(got.tailBytes).toBeLessThan(size / 8)
  })

  it('anchors on the newest occurrence of a duplicated marker', async () => {
    // The renderer's window grows contiguously from the tail, so the
    // occurrence at its edge is the newest; stopping at the older one (what
    // the forward scan did) would skip everything in between.
    const file = join(root, 'dup.jsonl')
    let body = ''
    for (let i = 0; i < 60; i += 1) {
      body += i === 5 || i === 50
        ? claudeLine(i, 'dup').replace(`"uuid":"u-${i}"`, '"uuid":"dup"')
        : claudeLine(i, 'x')
    }
    writeFileSync(file, body)
    const got = await readOlder(file, { kind: 'claude', beforeMarker: 'dup', limit: 5 }, 256)
    expect(seqs(got.entries)).toEqual([45, 46, 47, 48, 49])
    expect(got.hasMore).toBe(true)
  })
})
