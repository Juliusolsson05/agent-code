import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GhostEntry } from 'agent-transcript-parser/ghost'

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
// `source`): 7 never-superseded ghosts whose turns WERE committed, and those
// turns' 8 transcript records. What a restore must do with them:
//  - read the log under the persisted id;
//  - hold only a ghost the committed tail has NOT passed (anything older can
//    never paint, and most can never be superseded, #1227 review B F1/F2);
//  - supersede, from the loaded chunk, a held ghost whose turn is committed
//    (this fixture's newest turn: its ghosts postdate its own JSONL stamps by
//    ~227 ms, so only reconcile keeps them off screen);
//  - write back only what changed, never the log it just read (#731 grew
//    ghost logs to 2.1 GB by re-appending on every restore);
//  - keep an in-memory ghost over the file's copy of it.
//
// Honest scope (#1227 review): on the real restore of this pane these turns
// sit ABOVE the 120-record window, so there the tail alone hides them. The
// describe block further down pins what the merged feed paints, with more
// real sessions.

const fixture = JSON.parse(readFileSync(
  join(import.meta.dirname, '../../../../../../testing/fixtures/ghost-restore/943d15d6-committed-turns.json'),
  'utf8',
)) as {
  providerSessionId: string
  ghosts: Array<{ uuid: string; _atp: { turnId: string; createdAt: number; supersededBy?: string } }>
  transcriptRecords: Array<{ message?: { id?: string } }>
}

const SESSION = '943d15d6-8215-4e2c-bd57-03a0c022c381' as SessionId
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

async function restore(records: typeof fixture.transcriptRecords, inMemory: GhostEntry[] = []) {
  const state = {
    sessions: { [SESSION]: { cwd: '/repo', kind: 'claude', providerSessionId: fixture.providerSessionId } },
  } as unknown as WorkspaceState
  const refs = makeWorkspaceRefsForTest(state)
  let runtimes: Record<SessionId, SessionRuntime> = {
    [SESSION]: { ...emptyRuntime(), ghosts: new Map(inMemory.map(ghost => [ghost.uuid, ghost])) },
  }
  refs.latestRuntimesRef.current = runtimes
  const setRuntimes = (next: typeof runtimes | ((prev: typeof runtimes) => typeof runtimes)) => {
    runtimes = typeof next === 'function' ? next(runtimes) : next
    refs.latestRuntimesRef.current = runtimes
  }
  const ghostRead = vi.fn(async () => fixture.ghosts)
  const ghostAppend = vi.fn()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ghostRead,
      ghostAppend,
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
  return { runtime: runtimes[SESSION]!, ghostRead, ghostAppend }
}

const newestTurn = [...fixture.ghosts].sort((a, b) => a._atp.createdAt - b._atp.createdAt).at(-1)!._atp.turnId
const paintedGhosts = (runtime: SessionRuntime) => selectMergedEntries(
  { ...runtime, ghosts: orphanStale(runtime.ghosts, Date.now(), GHOST_ORPHAN_TTL_MS) },
  null,
).filter(entry => (entry as { _atp?: { origin?: string } })._atp?.origin === 'ghost').map(entry => entry.uuid)

describe('a restored pane reads its own ghost log (#1225)', () => {
  it('holds only what the tail has not passed, supersedes it from the chunk, and writes back only that', async () => {
    const { runtime, ghostRead, ghostAppend } = await restore(fixture.transcriptRecords)
    expect(ghostRead).toHaveBeenCalledWith(SESSION)
    const held = fixture.ghosts.filter(ghost => runtime.ghosts.has(ghost.uuid))
    // The newest turn's ghosts are the only ones newer than the tail.
    expect(new Set(held.map(ghost => ghost._atp.turnId))).toEqual(new Set([newestTurn]))
    for (const ghost of held) expect(runtime.ghosts.get(ghost.uuid)?._atp.supersededBy).toBeTruthy()
    // Exactly the supersedes are persisted; nothing read is re-appended (#731).
    const appended = ghostAppend.mock.calls.map(([, ghost]) => (ghost as GhostEntry).uuid)
    expect(appended.sort()).toEqual(held.map(ghost => ghost.uuid).sort())
    expect(paintedGhosts(runtime)).toEqual([])
  })

  it('paints the ghosts of a turn the transcript never got to (the crash case), and re-appends none of them', async () => {
    // Drop the NEWEST turn's committed records, as if Agent Code died before
    // Claude wrote them. Its ghosts are the only record of it.
    const records = fixture.transcriptRecords.filter(record => record.message?.id !== newestTurn)
    const { runtime, ghostAppend } = await restore(records)
    const lost = fixture.ghosts.filter(ghost => ghost._atp.turnId === newestTurn)
    for (const ghost of lost) {
      expect(runtime.ghosts.get(ghost.uuid)?._atp.supersededBy, `lost-turn ghost ${ghost.uuid}`).toBeUndefined()
    }
    expect(paintedGhosts(runtime).sort()).toEqual(lost.map(ghost => ghost.uuid).sort())
    // Only supersedes are written back (#731). Here that is the previous
    // turn's ghost: it postdates its own JSONL stamp by ~190 ms, so it too is
    // newer than this cut tail, and the chunk heals it. The lost turn's
    // ghosts, read from the log and unchanged, are not re-appended.
    const appended = ghostAppend.mock.calls.map(([, ghost]) => ghost as GhostEntry)
    for (const ghost of appended) expect(ghost._atp.supersededBy, ghost.uuid).toBeTruthy()
    expect(appended.some(ghost => ghost._atp.turnId === newestTurn)).toBe(false)
  })

  it('keeps the in-memory ghost over the log\'s copy of it', async () => {
    // A live pane re-reading its own log (a re-kicked load, a hydrate) holds
    // fresher state than the file; the file must not overwrite it.
    const onDisk = fixture.ghosts.find(ghost => ghost._atp.turnId === newestTurn)!
    const live = { ...onDisk, _atp: { ...onDisk._atp, orphanedAt: undefined, updatedAt: Date.now() } } as unknown as GhostEntry
    const records = fixture.transcriptRecords.filter(record => record.message?.id !== newestTurn)
    const { runtime } = await restore(records, [live])
    expect(runtime.ghosts.get(onDisk.uuid)).toBe(live)
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
