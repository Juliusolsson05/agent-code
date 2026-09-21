import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// feedDebugLog.ts had no test file, which is how #771 survived: the branch
// that fails closed on an unknown file size says in its own comment that it
// returns "WITHOUT advancing the cursor so the renderer resends these
// entries" — and a plain `return` RESOLVES the IPC, so the renderer's
// `.then` advances the cursor and never resends. The comment described an
// intention the code did not implement, and nothing was watching.

let statResult: { mode: 'real' } | { mode: 'throw'; code: string } = { mode: 'real' }
let stateDir = ''

vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  return {
    ...real,
    default: real,
    stat: async (path: Parameters<typeof real.stat>[0]) => {
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
