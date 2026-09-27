import { mkdir, mkdtemp, open, readFile, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// feedDebugLog.ts had no test file, which is how #771 survived: the branch
// that fails closed on an unknown file size says in its own comment that it
// returns "WITHOUT advancing the cursor so the renderer resends these
// entries" — and a plain `return` RESOLVES the IPC, so the renderer's
// `.then` advances the cursor and never resends. The comment described an
// intention the code did not implement, and nothing was watching.

let statResult: { mode: 'real' } | { mode: 'throw'; code: string } | { mode: 'hold'; gate: Promise<void>; reached: () => void } = { mode: 'real' }
let stateDir = ''

vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...real,
    default: real,
    stat: async (path: Parameters<typeof real.stat>[0]) => {
      if (statResult.mode === 'hold') {
        const held = statResult
        held.reached()
        await held.gate
      }
      if (statResult.mode === 'throw') {
        const err = new Error('stat refused') as NodeJS.ErrnoException
        err.code = statResult.code
        throw err
      }
      return await real.stat(path)
    },
  }
})

vi.mock('@main/storage/paths.js', () => ({
  get FEED_DEBUG_DIR() { return join(stateDir, 'feed-debug') },
  get STATE_DIR() { return stateDir },
}))

vi.mock('@main/storage/debugRetention.js', () => ({ scheduleDebugStoragePrune: () => {} }))

const { queueFeedDebugAppend, forgetFeedDebugSession } = await import('./feedDebugLog.js')
type FeedDebugPersistEntry = import('./feedDebugLog.js').FeedDebugPersistEntry

const entry = (id: number): FeedDebugPersistEntry => ({
  id,
  ts: 1_789_000_000_000 + id,
  tMs: id,
  layer: 'STATE',
  kind: 'probe',
  summary: `entry ${id}`,
  data: null,
})

const logPath = (sessionId: string) => join(stateDir, 'feed-debug', `${sessionId}.jsonl`)

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'ac-feed-debug-'))
  statResult = { mode: 'real' }
})

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true })
})

describe('#771 — an unknown on-disk size must not look like a successful write', () => {
  it('rejects so the renderer keeps the entries and retries', async () => {
    forgetFeedDebugSession('session-771')
    statResult = { mode: 'throw', code: 'EACCES' }

    // The renderer advances its durable cursor in `.then` and retains in
    // `.catch`. Resolving here is therefore indistinguishable from "written",
    // and those entries are gone for good — the one outcome the fail-closed
    // branch exists to prevent.
    await expect(queueFeedDebugAppend('session-771', [entry(1)], 1_000)).rejects.toThrow()
  })

  it('writes normally once the size is knowable again', async () => {
    forgetFeedDebugSession('session-771b')
    statResult = { mode: 'throw', code: 'EACCES' }
    await expect(queueFeedDebugAppend('session-771b', [entry(1)], 1_000)).rejects.toThrow()

    // The failure must not have poisoned the session's queue or cursor: the
    // retry is the whole point of failing closed.
    statResult = { mode: 'real' }
    await queueFeedDebugAppend('session-771b', [entry(1)], 1_000)

    const written = await readFile(logPath('session-771b'), 'utf8')
    expect(written.trim().split('\n')).toHaveLength(1)
    expect(written).toContain('"id":1')
  })
})

describe('#770 — a soft reload restarts entry ids below the persisted cursor', () => {
  it('writes the new generation instead of filtering it as already-seen', async () => {
    forgetFeedDebugSession('session-770')
    await queueFeedDebugAppend('session-770', [entry(1), entry(2), entry(3)], 1_000)

    // Soft reload resets the runtime's `feedDebugNextId` to 1 and its epoch to
    // null, so the next entries are ids 1..N again — while main still holds a
    // process-local cursor at 3 and drops everything at or below it. The
    // session's whole post-reload diagnostic trail disappears, silently,
    // exactly when someone is reloading BECAUSE the feed went weird.
    await queueFeedDebugAppend('session-770', [entry(1), entry(2)], 2_000)

    const lines = (await readFile(logPath('session-770'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(5)
  })

  it('still drops a genuine duplicate within one generation', async () => {
    // The cursor exists because two React effect passes can legally send the
    // same window while the first write is in flight. A reset keyed on the
    // epoch must not cost that.
    forgetFeedDebugSession('session-770b')
    await queueFeedDebugAppend('session-770b', [entry(1), entry(2)], 5_000)
    await queueFeedDebugAppend('session-770b', [entry(1), entry(2)], 5_000)

    const lines = (await readFile(logPath('session-770b'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
  })

  it('does not reset on an absent epoch from an older renderer', async () => {
    forgetFeedDebugSession('session-770c')
    await queueFeedDebugAppend('session-770c', [entry(1), entry(2)], undefined)
    await queueFeedDebugAppend('session-770c', [entry(1), entry(2)], undefined)

    const lines = (await readFile(logPath('session-770c'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
  })
})

describe('#770 — a reload does not re-open a capped log', () => {
  it('keeps dropping after the generation changes', async () => {
    // The epoch reset clears the de-dup CURSOR only. The cap state describes
    // the file on disk, which a reload does not shrink, so resetting it too
    // would let a flooding session write past 128 MiB again after every
    // reload. A sparse file at exactly the cap stands in for a real flood.
    forgetFeedDebugSession('session-cap')
    await mkdir(join(stateDir, 'feed-debug'), { recursive: true })
    await writeFile(logPath('session-cap'), '')
    await truncate(logPath('session-cap'), 128 * 1024 * 1024)

    await queueFeedDebugAppend('session-cap', [entry(1), entry(2)], 1_000)
    await queueFeedDebugAppend('session-cap', [entry(1), entry(2)], 2_000)

    const handle = await open(logPath('session-cap'), 'r')
    try {
      const size = (await handle.stat()).size
      const tail = Buffer.alloc(size - 128 * 1024 * 1024)
      await handle.read(tail, 0, tail.length, 128 * 1024 * 1024)
      const rows = tail.toString('utf8').trim().split('\n').filter(Boolean)
      // Only cap markers past the cap: no ordinary entry from either
      // generation.
      expect(rows.length).toBeGreaterThan(0)
      for (const row of rows) expect(row).toContain('__feedDebugCapped')
    } finally {
      await handle.close()
    }
  })
})

// #1207 (the #1111 reviewer's probe, real queue ordering): an append queued
// BEFORE forgetFeedDebugSession, and not started yet, used to run afterwards
// and write the per-session maps back. Nothing removed them again: a few
// numbers per closed session, forever.
describe('forget racing a queued append (#1207)', () => {
  it('leaves no per-session state behind for 100 sessions forgotten right after an append', async () => {
    const { feedDebugSessionStateSizesForTest } = await import('./feedDebugLog.js')
    const before = feedDebugSessionStateSizesForTest()
    const writes: Array<Promise<void>> = []
    for (let i = 0; i < 100; i++) {
      const sessionId = `forget-race-${i}`
      writes.push(queueFeedDebugAppend(sessionId, [entry(1)], 1_789_000_000_000).catch(() => undefined))
      forgetFeedDebugSession(sessionId)
    }
    await Promise.all(writes)
    expect(feedDebugSessionStateSizesForTest()).toEqual(before)
  })
})

// #1392 reviews a+b: the committed probe only covered successful writes.
describe('forget racing a queued append, other interleavings (#1392)', () => {
  it('drops state after a forgotten append fails its size check', async () => {
    const { feedDebugSessionStateSizesForTest } = await import('./feedDebugLog.js')
    statResult = { mode: 'throw', code: 'EACCES' }
    const write = queueFeedDebugAppend('forget-fail', [entry(1)], 1_789_000_000_000)
    forgetFeedDebugSession('forget-fail')
    await expect(write).rejects.toThrow()
    expect(feedDebugSessionStateSizesForTest('forget-fail')).toEqual({ ids: 0, epochs: 0, caps: 0, tokens: 0 })
  })

  it('lets a re-registered id write its first row after an old append of the same id', async () => {
    // Same id, same epoch: if the old append's cleanup only checked that SOME
    // token exists, it would keep its cursor and the new generation's id 1
    // would be filtered as already written.
    const first = queueFeedDebugAppend('reregistered', [entry(1)], 7_000)
    forgetFeedDebugSession('reregistered')
    const second = queueFeedDebugAppend('reregistered', [entry(1)], 7_000)
    await Promise.all([first, second])
    const lines = (await readFile(logPath('reregistered'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
  })

  it('keeps rejecting while the size stays unknown', async () => {
    forgetFeedDebugSession('still-unknown')
    statResult = { mode: 'throw', code: 'EACCES' }
    await expect(queueFeedDebugAppend('still-unknown', [entry(1)], 1_000)).rejects.toThrow()
    await expect(queueFeedDebugAppend('still-unknown', [entry(2)], 1_000)).rejects.toThrow()
  })
})

// #1392 review a, round 3: process exit forgets the session while the pane
// (and its log) stay live. A forget landing during the first `stat` used to
// drop the batch and RESOLVE, so the renderer advanced its cursor past rows
// that were never written.
describe('a forget during the first size check (#1392)', () => {
  it('still writes the batch, then leaves no state behind', async () => {
    const { feedDebugSessionStateSizesForTest } = await import('./feedDebugLog.js')
    let release!: () => void
    let reached!: () => void
    const atStat = new Promise<void>(resolve => { reached = resolve })
    statResult = { mode: 'hold', gate: new Promise<void>(resolve => { release = resolve }), reached }
    const write = queueFeedDebugAppend('exit-during-stat', [entry(1)], 1_000)
    await atStat
    forgetFeedDebugSession('exit-during-stat')
    statResult = { mode: 'real' }
    release()
    await write
    expect(await readFile(logPath('exit-during-stat'), 'utf8')).toContain('"id":1')
    expect(feedDebugSessionStateSizesForTest('exit-during-stat')).toEqual({ ids: 0, epochs: 0, caps: 0, tokens: 0 })
  })
})

// #1392 review a, round 4: cap state is rebuilt whenever a session is
// forgotten and appends again. A rebuilt state started its drop count at 0,
// so its tombstone reported 1 drop after an earlier row had reported 1,000.
describe('a rebuilt cap state keeps the file\'s drop count', () => {
  async function cappedFileWithMarker(sessionId: string, drops: number) {
    await mkdir(join(stateDir, 'feed-debug'), { recursive: true })
    await writeFile(logPath(sessionId), '')
    await truncate(logPath(sessionId), 128 * 1024 * 1024)
    await writeFile(logPath(sessionId), JSON.stringify({ sessionId, __feedDebugCapped: true, droppedEntriesSoFar: drops }) + '\n', { flag: 'a' })
  }
  async function lastMarkerDrops(sessionId: string): Promise<number> {
    const handle = await open(logPath(sessionId), 'r')
    try {
      const size = (await handle.stat()).size
      const tail = Buffer.alloc(4096)
      await handle.read(tail, 0, 4096, size - 4096)
      const tailSize = Math.min(size, 16_384)
      const wide = Buffer.alloc(tailSize)
      await handle.read(wide, 0, tailSize, size - tailSize)
      const markers = wide.toString('utf8').split('\n').flatMap(row => {
        try {
          const parsed = JSON.parse(row.slice(row.indexOf('{'))) as { __feedDebugCapped?: unknown; droppedEntriesSoFar?: number }
          return parsed.__feedDebugCapped === true ? [parsed.droppedEntriesSoFar ?? 0] : []
        } catch { return [] }
      })
      void tail
      return markers.at(-1) ?? -1
    } finally {
      await handle.close()
    }
  }

  it('after a forget and a new append', async () => {
    await cappedFileWithMarker('capped-rebuilt', 1_000)
    forgetFeedDebugSession('capped-rebuilt')
    await queueFeedDebugAppend('capped-rebuilt', [entry(1)], 1_000)
    expect(await lastMarkerDrops('capped-rebuilt')).toBeGreaterThanOrEqual(1_001)
  })

  // Review b, round 5: drops are only persisted at a doubling, so a forget
  // discarded up to half of them. Three forget cycles of 1 + 999 drops each
  // on a file marked at 1,000 used to leave a last marker of 1,003 for 4,000
  // true drops.
  it('across repeated forgets, the last marker stays within 2x of the true drops', async () => {
    await cappedFileWithMarker('capped-cycles', 1_000)
    let id = 0
    for (let cycle = 0; cycle < 3; cycle++) {
      forgetFeedDebugSession('capped-cycles')
      await queueFeedDebugAppend('capped-cycles', [entry(++id)], 1_000)
      await queueFeedDebugAppend('capped-cycles', Array.from({ length: 999 }, () => entry(++id)), 1_000)
    }
    forgetFeedDebugSession('capped-cycles')
    await queueFeedDebugAppend('capped-cycles', [], 1_000)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(await lastMarkerDrops('capped-cycles')).toBeGreaterThanOrEqual(4_000)
  })

  // Round-5 review a: the tail reader's three blind spots.
  it('below the cap: a marker written by an oversized entry keeps its count', async () => {
    await mkdir(join(stateDir, 'feed-debug'), { recursive: true })
    await writeFile(logPath('below-cap'), '')
    await truncate(logPath('below-cap'), 128 * 1024 * 1024 - 500)
    await writeFile(logPath('below-cap'), '\n', { flag: 'a' })
    const big = (id: number) => ({ ...entry(id), summary: 'x'.repeat(1_000) })
    await queueFeedDebugAppend('below-cap', [big(1)], 1_000)
    forgetFeedDebugSession('below-cap')
    await queueFeedDebugAppend('below-cap', [big(2)], 1_000)
    expect(await lastMarkerDrops('below-cap')).toBeGreaterThanOrEqual(2)
  })

  it('an ordinary row carrying the marker text in its data does not hide the real marker', async () => {
    await cappedFileWithMarker('marker-in-data', 1_000)
    await writeFile(logPath('marker-in-data'), JSON.stringify({ sessionId: 'marker-in-data', id: 9, data: { __feedDebugCapped: true, note: 'ordinary entry' } }) + '\n', { flag: 'a' })
    forgetFeedDebugSession('marker-in-data')
    await queueFeedDebugAppend('marker-in-data', [entry(1)], 1_000)
    expect(await lastMarkerDrops('marker-in-data')).toBeGreaterThanOrEqual(1_001)
  })

  it('a torn final row neither hides the earlier marker nor swallows the next row', async () => {
    await cappedFileWithMarker('torn-tail', 1_000)
    await writeFile(logPath('torn-tail'), '{"sessionId":"torn-tail","__feedDebugCapped":true,"droppedEntriesSoFar":20', { flag: 'a' })
    forgetFeedDebugSession('torn-tail')
    await queueFeedDebugAppend('torn-tail', [entry(1)], 1_000)
    expect(await lastMarkerDrops('torn-tail')).toBeGreaterThanOrEqual(1_001)
  })

  it('finds a marker behind several KiB of later rows', async () => {
    await cappedFileWithMarker('rows-after-marker', 1_000)
    const rows = Array.from({ length: 80 }, (_, i) => JSON.stringify({ sessionId: 'rows-after-marker', id: 100 + i, summary: 'y'.repeat(100) }) + '\n').join('')
    await writeFile(logPath('rows-after-marker'), rows, { flag: 'a' })
    forgetFeedDebugSession('rows-after-marker')
    await queueFeedDebugAppend('rows-after-marker', [entry(1)], 1_000)
    expect(await lastMarkerDrops('rows-after-marker')).toBeGreaterThanOrEqual(1_001)
  })

  it('after a forget during the first size check', async () => {
    await cappedFileWithMarker('capped-during-stat', 1_000)
    let release!: () => void
    let reached!: () => void
    const atStat = new Promise<void>(resolve => { reached = resolve })
    statResult = { mode: 'hold', gate: new Promise<void>(resolve => { release = resolve }), reached }
    const write = queueFeedDebugAppend('capped-during-stat', [entry(1)], 1_000)
    await atStat
    forgetFeedDebugSession('capped-during-stat')
    statResult = { mode: 'real' }
    release()
    await write
    expect(await lastMarkerDrops('capped-during-stat')).toBeGreaterThanOrEqual(1_001)
  })
})
