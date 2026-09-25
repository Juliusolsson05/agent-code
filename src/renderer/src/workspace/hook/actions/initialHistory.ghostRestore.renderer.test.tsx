import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

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
// it a two-sided test. The log must be read (the ghosts arrive), and every
// one must be superseded by its committed record (reading them without
// reconciling would paint duplicates of turns the transcript already shows).

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
