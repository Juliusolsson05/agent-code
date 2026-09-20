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

/** Four real turns, so the mapper produces four real markers. */
function seededSession() {
  const file = join(scope.dir(), 'cursor.db')
  const writer = new LiveFixtureWriter(file, PROVIDER_SESSION, sessionRowFor(PROVIDER_SESSION))
  scope.onCleanup(() => writer.close())
  for (const [index, text] of ['first', 'second', 'third', 'fourth'].entries()) {
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
      loadInitialHistory: vi.fn(async () => ({ ...chunk, entries: chunk.entries.slice(-2) })),
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
      loadInitialHistory: vi.fn(async () => ({ ...chunk, entries: chunk.entries.slice(-2) })),
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
