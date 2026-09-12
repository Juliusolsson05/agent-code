import { createHash } from 'node:crypto'
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
// `totalEntries` — while the bytes read for it are proportional to the
// window, not the file. The oracle below IS the removed forward
// implementation (streamJsonl + ring buffer / marker scan), so every
// equivalence assertion compares against the behaviour the app shipped
// with, not against a re-derivation of it.
//
// The second half covers the position cursor (PR #753 review): markers
// repeat in real transcripts, so paging must be anchored on the byte offset
// a previous chunk handed back, and must still TERMINATE without one.

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

function claudeLine(i: number, text: string, uuid = `u-${i}`): string {
  return JSON.stringify({
    type: i % 2 === 0 ? 'user' : 'assistant',
    uuid,
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

/** Byte offset of the line holding record `seq` (the previous newline + 1). */
function lineStartOf(bytes: Buffer, seq: number): number {
  const at = bytes.indexOf(Buffer.from(`"seq":${seq},`))
  expect(at, `record ${seq} present`).toBeGreaterThanOrEqual(0)
  return bytes.lastIndexOf(0x0a, at) + 1
}

/** Every offset must point at the line that parses to its entry. */
function expectOffsetsToAddress(file: string, entries: Entry[], offsets: number[]): void {
  const bytes = readFileSync(file)
  expect(offsets).toHaveLength(entries.length)
  for (const [i, offset] of offsets.entries()) {
    expect(offset === 0 || bytes[offset - 1] === 0x0a, `offset ${offset} on a line boundary`).toBe(true)
    const end = bytes.indexOf(0x0a, offset)
    const line = bytes.subarray(offset, end === -1 ? bytes.length : end).toString('utf8')
    expect(JSON.parse(line), `line at ${offset}`).toEqual(entries[i])
  }
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
      expectOffsetsToAddress(file, got.entries, got.offsets)
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
      expectOffsetsToAddress(file, got.entries, got.offsets)
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
    expect(chunk.offsets?.[0]).toBe(0)
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
      expectOffsetsToAddress(file, got.entries, got.offsets)
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
    // Provider-written transcripts never have junk in their head (the only
    // malformed line is the mid-append one at EOF), so this only ever shows
    // on a hand-edited file; a full parse to make the count exact there is
    // the cost #747 removed. Change this assertion knowingly if that
    // trade-off is ever revisited.
    expect(await readTail(file, 2, 48)).toMatchObject({ parsed: 8, parseErrors: 2 })
  })

  it('keeps a record containing a raw U+2028/U+2029 whole, where readline split it', async () => {
    // Valid JSON allows unescaped U+2028/U+2029 inside strings and Codex
    // writes them. Node's readline treats both as line terminators, so the
    // forward reader shredded such a record into unparseable fragments;
    // splitting on the 0x0A byte alone is the JSONL contract.
    const file = join(root, 'ls.jsonl')
    const text = 'first paragraph second third'
    writeFileSync(file, claudeLine(0, 'a') + claudeLine(1, text) + claudeLine(2, 'c'))
    const got = await readTail(file, 10, 32)
    expect(seqs(got.entries)).toEqual([0, 1, 2])
    expect(((got.entries[1]!.message as Entry).content as Entry[])[0]!.text).toBe(text)
    expect(got).toMatchObject({ parsed: 3, parseErrors: 0 })
    // The old reader saw fragments here; pin that the deviation is real so
    // a future "match readline exactly" change has to confront it.
    expect((await oracleTail(file, 10)).parseErrors).toBeGreaterThan(0)
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
  it('pages older history identically to the forward marker scan at every depth, with and without an offset', async () => {
    const file = writeClaude('pages.jsonl', 300)
    const bytes = readFileSync(file)
    for (const [anchor, limit] of [[299, 50], [280, 50], [150, 200], [37, 10], [1, 50], [0, 50]] as const) {
      const want = await oracleOlder(file, 'claude', `u-${anchor}`, limit)
      const byMarker = await readOlder(file, { kind: 'claude', beforeMarker: `u-${anchor}`, limit }, 4096)
      expect(byMarker.entries, `marker anchor ${anchor}`).toEqual(want.entries)
      expect(byMarker.hasMore, `marker anchor ${anchor}`).toBe(want.hasMore)
      expect(byMarker).toMatchObject({ foundMarker: true, anchor: 'marker' })
      expectOffsetsToAddress(file, byMarker.entries, byMarker.offsets)

      const byOffset = await readOlder(
        file,
        { kind: 'claude', beforeMarker: `u-${anchor}`, beforeOffset: lineStartOf(bytes, anchor), limit },
        4096,
      )
      expect(byOffset.entries, `offset anchor ${anchor}`).toEqual(want.entries)
      expect(byOffset.hasMore, `offset anchor ${anchor}`).toBe(want.hasMore)
      expect(byOffset).toMatchObject({ foundMarker: true, anchor: 'offset' })
      expectOffsetsToAddress(file, byOffset.entries, byOffset.offsets)
    }
    // The public entrypoint shapes the "nothing before the first record"
    // case as the end of pagination.
    expect(await loadOlderHistoryChunkFromFile(file, { kind: 'claude', beforeMarker: 'u-0', beforeOffset: 0, limit: 50 }))
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
      expect(got).toMatchObject({ foundMarker: false, anchor: 'tail' })
      expect(got.entries, `limit ${limit}`).toEqual(want.entries)
      expect(got.hasMore, `limit ${limit}`).toBe(want.hasMore)
    }
  })

  it('reads only from the offset back to the page, not from either end of the file', async () => {
    const file = writeClaude('deep.jsonl', 400, i => `${'y'.repeat(10_000)} ${i}`)
    const bytes = readFileSync(file)
    const size = bytes.length
    const blockBytes = 64 * 1024
    const recordBytes = Buffer.byteLength(claudeLine(200, `${'y'.repeat(10_000)} 200`))
    // Anchor in the middle of a ~4 MB file: the exact path reads the anchor
    // line (its check) plus 11 records before it — ~120 KB — where both a
    // head scan and a tail scan would read ~2 MB.
    const got = await readOlder(
      file,
      { kind: 'claude', beforeMarker: 'u-200', beforeOffset: lineStartOf(bytes, 200), limit: 10 },
      blockBytes,
    )
    expect(got.anchor).toBe('offset')
    expect(seqs(got.entries)).toEqual([190, 191, 192, 193, 194, 195, 196, 197, 198, 199])
    expect(got.hasMore).toBe(true)
    expect(got.tailBytes).toBeLessThanOrEqual(12 * recordBytes + blockBytes)
    expect(got.tailBytes).toBeLessThan(size / 16)
  })

  it('refuses an offset whose line does not carry the marker and falls back safely', async () => {
    const file = writeClaude('bad-offset.jsonl', 60)
    const bytes = readFileSync(file)
    const want = await oracleOlder(file, 'claude', 'u-40', 5)
    const lineStart = (seq: number): number => lineStartOf(bytes, seq)
    const cases: Array<[string, number | undefined]> = [
      ['a different record\'s line', lineStart(41)],
      ['mid-line (not a line boundary)', lineStart(40) + 3],
      ['past EOF', bytes.length + 10],
      ['negative', -1],
      ['not an integer', 12.5],
      ['undefined', undefined],
    ]
    for (const [label, beforeOffset] of cases) {
      const got = await readOlder(file, { kind: 'claude', beforeMarker: 'u-40', beforeOffset, limit: 5 }, 512)
      expect(got.anchor, label).toBe('marker')
      expect(got.entries, label).toEqual(want.entries)
      expect(got.hasMore, label).toBe(true)
    }
    // The honest offset takes the exact path and agrees.
    const ok = await readOlder(file, { kind: 'claude', beforeMarker: 'u-40', beforeOffset: lineStart(40), limit: 5 }, 512)
    expect(ok.anchor).toBe('offset')
    expect(ok.entries).toEqual(want.entries)
  })

  // The renderer's cursor rule (history.ts / initialHistory.ts): after each
  // chunk the cursor is the marker of the first kept line, plus — when the
  // chunk carries offsets — that line's offset. Every record here is
  // renderable, so "first kept" is simply the first returned record.
  async function pageToHead(
    file: string,
    limit: number,
    useOffsets: boolean,
  ): Promise<{ pages: number; reached: number[] }> {
    const initial = await loadInitialHistoryChunkFromFile(file, limit)
    const reached = seqs(initial.entries)
    let marker = claudeMarker(initial.entries[0]!)!
    let offset: number | undefined = useOffsets ? initial.offsets?.[0] : undefined
    let hasMore = initial.hasMore
    let pages = 0
    while (hasMore) {
      pages += 1
      if (pages > 200) throw new Error(`still paging after ${pages} pages — livelock`)
      const chunk = await loadOlderHistoryChunkFromFile(file, {
        kind: 'claude',
        beforeMarker: marker,
        beforeOffset: offset,
        limit,
      })
      reached.unshift(...seqs(chunk.entries))
      hasMore = chunk.hasMore
      if (chunk.entries.length > 0) {
        marker = claudeMarker(chunk.entries[0]!)!
        offset = useOffsets ? chunk.offsets?.[0] : undefined
      }
    }
    return { pages, reached }
  }

  /** Records 0–29 carry uuids A0..A29, records 30–59 carry A0..A29 AGAIN
   *  with different text, 60–79 are unique — the reviewer's minimal input
   *  that cycled the newest-occurrence cursor (55 → 45 → 35 → 25 → 55 …). */
  function writeDuplicatedMarkers(name: string): string {
    const file = join(root, name)
    let body = ''
    for (let i = 0; i < 80; i += 1) {
      const uuid = i < 60 ? `A${i % 30}` : `unique-${i}`
      body += claudeLine(i, i < 30 ? `first ${i}` : i < 60 ? `again ${i}` : `tail ${i}`, uuid)
    }
    writeFileSync(file, body)
    return file
  }

  it('pages a transcript with repeated markers to the head, reaching every record exactly once, with the offset cursor', async () => {
    const file = writeDuplicatedMarkers('dup-offsets.jsonl')
    const { pages, reached } = await pageToHead(file, 10, true)
    expect(reached).toEqual(Array.from({ length: 80 }, (_, i) => i))
    expect(pages).toBe(7)
  })

  it('still terminates on repeated markers without an offset (oldest-occurrence scan, lossy as before)', async () => {
    const file = writeDuplicatedMarkers('dup-markers.jsonl')
    const { pages, reached } = await pageToHead(file, 10, false)
    // Terminates, and never delivers a record twice.
    expect(new Set(reached).size).toBe(reached.length)
    expect(pages).toBeLessThanOrEqual(8)
    // Lossy across the duplicate gap, exactly like the original forward
    // scan: pages 70–79 (tail), 60–69, 50–59 leave the cursor at record
    // 50 = A20, which the oldest-occurrence scan resolves to record 20, so
    // 20–49 are skipped and paging ends after 10–19 and 0–9. That is the
    // trade-off the offset cursor exists to remove.
    expect(reached).toEqual([...Array.from({ length: 20 }, (_, i) => i), ...Array.from({ length: 30 }, (_, i) => 50 + i)])
    expect(pages).toBe(4)
  })
})


it('control cursors page records without UI markers and reject an edited boundary instead of falling back', async () => {
  // This is a file-position fault probe. Record bodies are real checked-in
  // provider data; the edit deliberately simulates replacement under a cursor.
  const fixture = JSON.parse(readFileSync(new URL('../../../testing/fixtures/rendering-bundles/2026-07-07T13-17-48-452-5b19529f.json', import.meta.url), 'utf8'))
  const records: Entry[] = fixture.input.entries
  const file = join(root, 'real-records.jsonl')
  writeFileSync(file, records.map(record => JSON.stringify(record)).join('\n') + '\n')
  const tail = await loadInitialHistoryChunkFromFile(file, 12)
  const hash = createHash('sha256').update(JSON.stringify(tail.entries[0])).digest('hex')
  const request = { kind: 'claude' as const, beforeMarker: '', beforeOffset: tail.offsets![0], beforeRecordHash: hash, limit: 12 }
  const previous = await loadOlderHistoryChunkFromFile(file, request)
  expect(previous.entries).toEqual(records.slice(-24, -12))
  const changed = readFileSync(file, 'utf8')
  const offset = request.beforeOffset
  const buffer = Buffer.from(changed)
  // Same inode/size; only the exact boundary hash can detect this edit.
  const at = buffer.indexOf(Buffer.from('"'), offset) + 1
  buffer[at] = buffer[at] === 120 ? 121 : 120
  writeFileSync(file, buffer)
  await expect(loadOlderHistoryChunkFromFile(file, request)).rejects.toThrow('boundary')
})
