import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { LiveFixtureWriter, sessionRowFor } from 'opencode-terminal-headless/testing'

import { emptyRuntime } from '@renderer/session-runtime/state'
import { opencodeTerminalScope, paneMeta, SESSION_ID } from '@renderer/workspace/hook/ipc/testing/opencodeTerminalScope'
import { seedResumedRuntimeFields } from '@renderer/workspace/providerSessionIdentity'

import { loadInitialHistoryForSession } from './initialHistory'

// ---------------------------------------------------------------------------
// #910 item 3. The pagination cursor names the OLDEST entry the pane holds.
//
// Re-hydrating a tail the window ALREADY holds produces an all-anchor
// placement: nothing is added, `appendedAfterWindow` is false, and the loader
// used to read that as "this chunk is now the window", moving the cursor
// FORWARD to the chunk's head. The next older page then landed above
// everything the pane had already paged in.
//
// Driven through the real loader over a REAL OpenCode database, because the
// pagination marker is produced by the raw-entry mapper — not by a field a
// stub can set. An earlier version of this test used hand-shaped entries and
// passed vacuously: with no marker derived, the cursor could not move whether
// the fix was present or not.
// ---------------------------------------------------------------------------

const scope = opencodeTerminalScope()
const PROVIDER_SESSION = 'ses_cursor'

/** Real turns, so the mapper produces real markers. */
function seededSession(texts: string[] = ['first', 'second', 'third', 'fourth']) {
  const file = join(scope.dir(), `cursor-${texts.length}.db`)
  const writer = new LiveFixtureWriter(file, PROVIDER_SESSION, sessionRowFor(PROVIDER_SESSION))
  scope.onCleanup(() => writer.close())
  for (const [index, text] of texts.entries()) {
    const id = `msg_${index}`
    writer.apply('message.updated.1', {
      sessionID: PROVIDER_SESSION,
      info: { id, sessionID: PROVIDER_SESSION, role: 'user', time: { created: index + 1 } },
    })
    writer.apply('message.part.updated.1', {
      sessionID: PROVIDER_SESSION,
      part: { id: `prt_${index}`, sessionID: PROVIDER_SESSION, messageID: id, type: 'text', text },
    })
  }
  return scope.serveHistoryFrom(file)
}

/**
 * Slice a recorded chunk the way the loader will read it.
 *
 * WHY offsets are sliced alongside entries: `chunk.offsets` is documented as
 * PARALLEL to `chunk.entries`, and the loader indexes it by raw entry index.
 * The OpenCode history source emits none today, so a fixture that sliced only
 * the entries was harmless — and would have quietly broken the invariant for
 * the first provider that does (#1081 review, finding 4).
 */
const slice = (chunk: { entries: unknown[]; offsets?: number[] }, from: number) => ({
  ...chunk,
  entries: chunk.entries.slice(from),
  ...(chunk.offsets ? { offsets: chunk.offsets.slice(from) } : {}),
})

const pane = (runtime: Record<string, unknown>) => scope.restoredPane(PROVIDER_SESSION, {
  ...emptyRuntime(),
  ...seedResumedRuntimeFields(undefined, paneMeta(PROVIDER_SESSION)),
  ...runtime,
})

describe('a no-op tail refresh leaves the cursor alone (#910 item 3)', () => {
  it('keeps the oldest marker when the chunk adds nothing', async () => {
    const history = seededSession()
    // First load: the real thing, which gives a real window and a real cursor.
    const first = pane({})
    scope.extendApi({ loadInitialHistory: history.loadInitialHistory })
    await loadInitialHistoryForSession({
      sessionId: SESSION_ID, meta: first.meta, refs: first.refs, setRuntimes: first.setRuntimes,
    })
    const loaded = first.runtime()
    expect(loaded.entries.length).toBeGreaterThan(2)
    const oldestMarker = loaded.historyOldestMarker
    expect(oldestMarker).toBeTruthy()

    // Now a pane holding that same window, and a bridge that answers with only
    // the TAIL of it — every entry already seen, nothing new. That is a
    // rehydrate or an MCP read landing on a pane that has already paged.
    const chunk = await history.loadInitialHistory({ cwd: '/tmp', providerSessionId: PROVIDER_SESSION, limit: 120 })
    scope.extendApi({
      loadInitialHistory: vi.fn(async () => slice(chunk, -2)),
    })
    const paged = pane({
      entries: loaded.entries,
      historyOldestMarker: oldestMarker,
      historyOldestOffset: loaded.historyOldestOffset,
    })
    await loadInitialHistoryForSession({
      sessionId: SESSION_ID, meta: paged.meta, refs: paged.refs, setRuntimes: paged.setRuntimes,
    })

    // THE REGRESSION. This used to become the TAIL's marker — forward of the
    // window's real oldest entry — so the next older page landed above it.
    expect(paged.runtime().historyOldestMarker).toBe(oldestMarker)
    expect(paged.runtime().entries).toHaveLength(loaded.entries.length)
  })

  it('DOES move the cursor when the chunk contributes older entries', async () => {
    // The control. Without it, "the cursor never moves" would pass too, and
    // the cursor would stop tracking the window it names.
    const history = seededSession()
    const chunk = await history.loadInitialHistory({ cwd: '/tmp', providerSessionId: PROVIDER_SESSION, limit: 120 })
    scope.extendApi({ loadInitialHistory: vi.fn(async () => chunk) })

    // A pane holding only the tail, with its cursor on the tail's head.
    const tailOnly = pane({})
    scope.extendApi({
      loadInitialHistory: vi.fn(async () => slice(chunk, -2)),
    })
    await loadInitialHistoryForSession({
      sessionId: SESSION_ID, meta: tailOnly.meta, refs: tailOnly.refs, setRuntimes: tailOnly.setRuntimes,
    })
    const tailMarker = tailOnly.runtime().historyOldestMarker
    expect(tailMarker).toBeTruthy()

    // The full chunk now arrives, which really does add older entries.
    scope.extendApi({ loadInitialHistory: vi.fn(async () => chunk) })
    await loadInitialHistoryForSession({
      sessionId: SESSION_ID, meta: tailOnly.meta, refs: tailOnly.refs, setRuntimes: tailOnly.setRuntimes,
    })

    expect(tailOnly.runtime().historyOldestMarker).not.toBe(tailMarker)
    expect(tailOnly.runtime().entries.length).toBeGreaterThan(2)
  })
})

describe('the prefix flush must not take the cursor with it (#1081 review, finding 1)', () => {
  it('keeps the cursor on the window\'s oldest row when a fresh entry lands INSIDE the window', async () => {
    // Item 2's flush changed which row ends up at merged[0], and the cursor
    // rule still said "this load added a fresh entry, so the chunk's head is
    // now the oldest row". It is not: the flush put the WINDOW's head first.
    // The cursor then named a row that is not the oldest, and the next older
    // page prepended above a row that precedes it — permanently, because uuid
    // dedup fixes the order. Item 2's fix had recreated item 3 from the other
    // side.
    //
    // Six real turns so the window can hold a GAP, which is the shape that
    // makes a fresh entry land inside it: a pane whose live stream moved on
    // before msg_2/msg_3 committed.
    const history = seededSession(['t0', 't1', 't2', 't3', 't4', 't5'])
    const full = await history.loadInitialHistory({ cwd: '/tmp', providerSessionId: PROVIDER_SESSION, limit: 120 })

    // The pane as it stands: [msg_1, msg_4, msg_5], cursor on msg_1.
    const loadAll = pane({})
    scope.extendApi({ loadInitialHistory: vi.fn(async () => slice(full, 1)) })
    await loadInitialHistoryForSession({
      sessionId: SESSION_ID, meta: loadAll.meta, refs: loadAll.refs, setRuntimes: loadAll.setRuntimes,
    })
    const windowed = loadAll.runtime()
    expect(windowed.historyOldestMarker).toBe('msg_1')
    const gapped = windowed.entries.filter(entry => {
      const uuid = (entry as { uuid?: string }).uuid
      return uuid !== 'msg_2' && uuid !== 'msg_3'
    })
    expect(gapped.map(entry => (entry as { uuid?: string }).uuid)).toEqual(['msg_1', 'msg_4', 'msg_5'])

    // A rehydrate delivers the newest three: msg_3 is fresh, msg_4/msg_5 are
    // anchors.
    scope.extendApi({ loadInitialHistory: vi.fn(async () => slice(full, -3)) })
    const paned = pane({
      entries: gapped,
      historyOldestMarker: 'msg_1',
      historyOldestOffset: windowed.historyOldestOffset,
    })
    await loadInitialHistoryForSession({
      sessionId: SESSION_ID, meta: paned.meta, refs: paned.refs, setRuntimes: paned.setRuntimes,
    })

    const after = paned.runtime()
    // Item 2's own promise: msg_3 goes between msg_1 and msg_4, not above both.
    expect(after.entries.map(entry => (entry as { uuid?: string }).uuid))
      .toEqual(['msg_1', 'msg_3', 'msg_4', 'msg_5'])
    // THE REGRESSION. This became 'msg_3' — a row the pane holds in the
    // middle — so the next older page would land above msg_1.
    expect(after.historyOldestMarker).toBe('msg_1')
  })
})
