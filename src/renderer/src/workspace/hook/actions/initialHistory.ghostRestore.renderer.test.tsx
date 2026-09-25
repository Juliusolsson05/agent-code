import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { GHOST_ORPHAN_TTL_MS, orphanStale } from '@renderer/session-runtime/ghosts'
import { selectMergedEntries } from '@renderer/session-runtime/mergedEntries'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import { makeWorkspaceRefsForTest } from '@renderer/workspace/hook/ipc/testing/workspaceRefsForTest'

import { loadInitialHistoryForSession } from './initialHistory'

// #1225: a RESTORED pane never read its ghost log. The only reader ran in
// `spawn`, under an id main had minted a moment earlier, so crash-resume (the
// ghost system's reason to exist, docs/design/ghost-system.md "Crash +
// restart") has done nothing since the July recovery rewrite. A restore goes
// through this loader with the pane's PERSISTED id, so this is where the log
// has to be read.
//
// The data is a real pair from the owner's machine (see the fixture's
// `source`): 7 never-superseded ghosts whose turns WERE committed. That makes
// it a two-sided test. The log must be read (the ghosts arrive), and a ghost
// whose committed record IS in the loaded chunk must be superseded by it.
//
// Honest scope (#1227 review, finding 3): on the real restore of this pane
// those 7 turns sit ABOVE the 120-record window, so reconcile never sees
// them there; what keeps them off screen in production is render rule 4 with
// each ghost re-dated to its own createdAt. The describe block further down
// pins that, on the merged feed, with two more real sessions.

const fixture = JSON.parse(readFileSync(
  join(import.meta.dirname, '../../../../../../testing/fixtures/ghost-restore/943d15d6-committed-turns.json'),
  'utf8',
)) as {
  providerSessionId: string
  ghosts: Array<{ uuid: string; _atp: { turnId: string; supersededBy?: string } }>
  transcriptRecords: Array<{ message?: { id?: string } }>
}

const SESSION = '943d15d6-8215-4e2c-bd57-03a0c022c381' as SessionId
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

async function restore(records: typeof fixture.transcriptRecords) {
  const state = {
    sessions: { [SESSION]: { cwd: '/repo', kind: 'claude', providerSessionId: fixture.providerSessionId } },
  } as unknown as WorkspaceState
  const refs = makeWorkspaceRefsForTest(state)
  let runtimes: Record<SessionId, SessionRuntime> = { [SESSION]: emptyRuntime() }
  refs.latestRuntimesRef.current = runtimes
  const setRuntimes = (next: typeof runtimes | ((prev: typeof runtimes) => typeof runtimes)) => {
    runtimes = typeof next === 'function' ? next(runtimes) : next
    refs.latestRuntimesRef.current = runtimes
  }
  const ghostRead = vi.fn(async () => fixture.ghosts)
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ghostRead,
      ghostAppend: vi.fn(),
      gitWorktrees: vi.fn(async () => ({ ok: false })),
      reportSessionLifecycle: vi.fn(),
    },
  })
  await loadInitialHistoryForSession({
    sessionId: SESSION,
    refs,
    setRuntimes: setRuntimes as never,
    feed: { loadHistory: vi.fn(async () => ({ entries: records, hasMore: false, totalEntries: records.length })) } as never,
  })
  return { runtime: runtimes[SESSION]!, ghostRead }
}

describe('a restored pane reads its own ghost log (#1225)', () => {
  it('reads the log under the persisted id and supersedes every ghost whose turn is committed', async () => {
    const { runtime, ghostRead } = await restore(fixture.transcriptRecords)
    expect(ghostRead).toHaveBeenCalledWith(SESSION)
    for (const ghost of fixture.ghosts) {
      const restored = runtime.ghosts.get(ghost.uuid)
      expect(restored, `ghost ${ghost.uuid} of ${ghost._atp.turnId}`).toBeDefined()
      expect(restored?._atp.supersededBy, `ghost of committed turn ${ghost._atp.turnId}`).toBeTruthy()
    }
  })

  it('keeps a ghost whose turn never reached the transcript (the crash case)', async () => {
    // Drop one turn's committed records, as if Agent Code died before Claude
    // wrote them. That turn's ghosts are the only record of it and must stay.
    const lostTurn = fixture.ghosts[0]!._atp.turnId
    const { runtime } = await restore(fixture.transcriptRecords.filter(record => record.message?.id !== lostTurn))
    const lost = fixture.ghosts.filter(ghost => ghost._atp.turnId === lostTurn)
    expect(lost.length).toBeGreaterThan(0)
    for (const ghost of lost) {
      expect(runtime.ghosts.get(ghost.uuid), `lost-turn ghost ${ghost.uuid}`).toBeDefined()
      expect(runtime.ghosts.get(ghost.uuid)?._atp.supersededBy).toBeFalsy()
    }
  })
})

// #1227 review (reviewer A, findings 1 and 2): reading the log is only half of
// it. What a restored ghost PAINTS is decided by render rule 4, which shows an
// orphan only when it is newer than the committed tail — and a log's orphan
// time is the renderer clock at the moment it gave up (last update + 30 s),
// or, for a ghost the log never saw orphaned, the restore itself. Neither is
// when the ghost's turn happened. Both real cases below painted committed
// turns a second time at the bottom of the feed:
//
//  - Codex: text ghosts are minted under the proxy response id, which never
//    matches the rollout's turn id, so they are never superseded; each was
//    orphaned ~30 s after the turn's final commit, i.e. "after the tail".
//    The restored feed ended with its own final answer twice.
//  - Claude: two tool-call ghosts whose last write predates their orphaning
//    (the app reloaded inside the 30 s TTL). Their turns are committed far
//    above the loaded window, so reconcile never sees them, and the first
//    sweep orphaned them at restore time: newest thing in the pane.
//
// The fixture is real (see its `source`). The assertion is on the merged feed
// the pane renders, not on ghost internals.

const stale = JSON.parse(readFileSync(
  join(import.meta.dirname, '../../../../../../testing/fixtures/ghost-restore/stale-ghosts-after-restore.json'),
  'utf8',
)) as Record<'claude' | 'codex' | 'codexStraddle', {
  sessionId: string
  providerSessionId: string
  ghosts: Array<{ uuid: string; _atp: { createdAt: number; turnId: string } }>
  transcriptTail: Array<{ timestamp?: string }>
}>

async function restoreCase(
  which: 'claude' | 'codex' | 'codexStraddle',
  records: Array<{ timestamp?: string }> = stale[which].transcriptTail,
) {
  const data = stale[which]
  const kind = which === 'claude' ? 'claude' : 'codex'
  const sessionId = data.sessionId as SessionId
  const state = {
    sessions: { [sessionId]: { cwd: '/repo', kind, providerSessionId: data.providerSessionId } },
  } as unknown as WorkspaceState
  const refs = makeWorkspaceRefsForTest(state)
  let runtimes: Record<SessionId, SessionRuntime> = { [sessionId]: emptyRuntime() }
  refs.latestRuntimesRef.current = runtimes
  const setRuntimes = (next: typeof runtimes | ((prev: typeof runtimes) => typeof runtimes)) => {
    runtimes = typeof next === 'function' ? next(runtimes) : next
    refs.latestRuntimesRef.current = runtimes
  }
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ghostRead: vi.fn(async () => data.ghosts),
      ghostAppend: vi.fn(),
      gitWorktrees: vi.fn(async () => ({ ok: false })),
      reportSessionLifecycle: vi.fn(),
    },
  })
  await loadInitialHistoryForSession({
    sessionId,
    refs,
    setRuntimes: setRuntimes as never,
    feed: { loadHistory: vi.fn(async () => ({ entries: records, hasMore: false, totalEntries: records.length })) } as never,
  })
  // The first orphan sweep after a restore, exactly as the 1 s tick runs it:
  // any ghost the log left un-orphaned has long outlived its 30 s TTL.
  const runtime = runtimes[sessionId]!
  const swept = { ...runtime, ghosts: orphanStale(runtime.ghosts, Date.now(), GHOST_ORPHAN_TTL_MS) }
  const painted = selectMergedEntries(swept, null)
    .filter(entry => (entry as { _atp?: { origin?: string } })._atp?.origin === 'ghost')
    .map(entry => entry.uuid)
  return { runtime: swept, painted }
}

describe('what a restored pane paints from its ghost log (#1227 review)', () => {
  it.each(['claude', 'codex'] as const)('paints no %s ghost whose turn predates the committed tail', async kind => {
    const { painted } = await restoreCase(kind, stale[kind].transcriptTail)
    expect(painted).toEqual([])
  })

  it('still paints a ghost of a turn that started after the last commit (the crash case)', async () => {
    // The reason the log is read at all: the process died mid-turn, so the
    // transcript ends BEFORE the turn the ghosts describe. Cut the real Codex
    // tail back to just before its last ghost (the 1.5 kB final answer) was
    // created: the tail then ends on the turn's earlier tool calls.
    const last = [...stale.codex.ghosts].sort((a, b) => a._atp.createdAt - b._atp.createdAt).at(-1)!
    const before = stale.codex.transcriptTail.filter(record =>
      record.timestamp !== undefined && Date.parse(record.timestamp) < last._atp.createdAt)
    expect(before.length).toBeGreaterThan(0)
    const { painted } = await restoreCase('codex', before)
    expect(painted).toEqual([last.uuid])
  })

  it('still paints a ghost that began BEFORE the last commit but kept streaming after it (steering q6)', async () => {
    // Recorded (see the fixture's codexStraddle.note): a tool-call ghost was
    // created 34 ms BEFORE a different assistant message was committed (the
    // rollout write lags the proxy), then kept streaming for seconds. Crash
    // right after that commit and the transcript ends past the ghost's
    // creation while the tool call exists only in the ghost. Judging it by
    // createdAt hid the only copy; its LAST content update is what decides.
    const { painted } = await restoreCase('codexStraddle')
    expect(painted).toEqual([stale.codexStraddle.ghosts.at(-1)!.uuid])
  })
})
