import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { loadLiveFixture, referenceActiveBranch, toJsonl, type RecordedRow } from 'pi-terminal-headless/testing/index'

import { loadPiHistoryChunk } from '@providers/pi/runtime/piHistory'
import { entryTextContent } from '@renderer/session-runtime/entries'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import { freshStage } from '@renderer/workspace/dispatch/gridShape'
import { makeWorkspaceRefsForTest } from '@renderer/workspace/hook/ipc/testing/workspaceRefsForTest'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'

import { loadInitialHistoryForSession } from './initialHistory'

// Astra review finding 1: a Pi pane that follows pi into another session
// (/new here) rebinds its identity and resets its history window. A history
// load that started on the OLD session and settles after that must not land
// in the new session's window: its rows are another conversation's, and View
// Prompts and the orchestration reads serve whatever the window holds.
//
// The old session is the `new-session` recording's first file, read by the
// app's real Pi history reader and mapped by the real mapper. The switch is
// applied the way the pane's two handlers apply it (useIpcSubscriptions:
// provider-session-changed rebinds `providerSessionId`, the history reset
// advances the window generation); the pane harness cannot hold a load open
// across a replay, so this drives the loader directly.

const PANE = 'pi-pane' as SessionId
const dirs: string[] = []
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

function setup() {
  const fixture = loadLiveFixture('new-session')
  const [first, second] = fixture.events.filter(event => event.name === 'session_start')
  const dir = mkdtempSync(join(tmpdir(), 'pi-superseded-'))
  dirs.push(dir)
  const oldRows = fixture.files[first!.sessionFile as string]!
  const oldFile = join(dir, 'old.jsonl')
  writeFileSync(oldFile, toJsonl(oldRows))
  const oldPrompts = referenceActiveBranch(oldRows)
    .filter((row: RecordedRow) => row.type === 'message' && (row.message as { role: string }).role === 'user')
    .map(row => ((row.message as { content: Array<{ text?: string }> }).content).map(b => b.text ?? '').join(''))
  expect(oldPrompts.length).toBeGreaterThan(0) // the old session really has a conversation to leak

  const state: WorkspaceState = {
    tabs: [{ id: 'project', title: 'project' }], activeTabId: 'project', stage: freshStage(), pinnedSessionIds: [],
    sessions: { [PANE]: { cwd: '/sandbox/project', kind: 'pi', providerSessionId: first!.sessionId as string, projectId: 'project', joinedAt: 1 } },
  }
  const refs = makeWorkspaceRefsForTest(state)
  let runtimes: Record<SessionId, SessionRuntime> = { [PANE]: emptyRuntime() }
  const setRuntimes = (next: typeof runtimes | ((prev: typeof runtimes) => typeof runtimes)) => {
    runtimes = typeof next === 'function' ? next(runtimes) : next
  }
  const followPiIntoNewSession = () => {
    const meta = refs.stateRef.current.sessions[PANE]!
    refs.stateRef.current = { ...refs.stateRef.current, sessions: { [PANE]: { ...meta, providerSessionId: second!.sessionId as string } } }
    refs.historyWindowsRef.current[PANE] = { generation: 1, file: second!.sessionFile as string, awaitingCaughtUp: true }
  }
  // Each read waits for the test, so the switch can land mid-read.
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  Object.defineProperty(window, 'api', { configurable: true, value: {
    gitWorktrees: vi.fn(async () => ({ ok: false })),
    reportSessionLifecycle: vi.fn(),
    ghostAppend: vi.fn(),
  } })
  return { refs, setRuntimes, runtime: () => runtimes[PANE]!, oldFile, oldPrompts, followPiIntoNewSession, gate, release: () => release() }
}

describe('an initial-history load that the pane outlived', () => {
  it('does not merge the old session’s conversation into the one pi moved to', async () => {
    const { refs, setRuntimes, runtime, oldFile, oldPrompts, followPiIntoNewSession, gate, release } = setup()
    const load = loadInitialHistoryForSession({
      sessionId: PANE, refs, setRuntimes: setRuntimes as never,
      readHistory: (async (request: Parameters<typeof loadPiHistoryChunk>[0]) => {
        await gate
        return loadPiHistoryChunk(request, { resolveFile: async () => oldFile })
      }) as never,
    })
    followPiIntoNewSession()
    release()
    await expect(load).resolves.toBe(false)
    const shown = runtime().entries.map(entry => entryTextContent(entry))
    for (const prompt of oldPrompts) expect(shown).not.toContain(prompt)
    // Settled, not stranded at 'loading' for the stuck-load reconciler.
    expect(runtime().transcriptStatus).toBe('ready')
  })

  it('does not mark the new session broken when the old session’s read fails', async () => {
    const { refs, setRuntimes, runtime, followPiIntoNewSession, gate, release } = setup()
    const load = loadInitialHistoryForSession({
      sessionId: PANE, refs, setRuntimes: setRuntimes as never,
      readHistory: (async () => {
        await gate
        throw new Error('not_a_session: old.jsonl')
      }) as never,
    })
    followPiIntoNewSession()
    release()
    await expect(load).resolves.toBe(false)
    expect(runtime()).toMatchObject({ transcriptStatus: 'ready', transcriptError: null })
  })

  it('still applies a load whose session did not change', async () => {
    const { refs, setRuntimes, runtime, oldFile, oldPrompts, release } = setup()
    release()
    await expect(loadInitialHistoryForSession({
      sessionId: PANE, refs, setRuntimes: setRuntimes as never,
      readHistory: ((request: Parameters<typeof loadPiHistoryChunk>[0]) => loadPiHistoryChunk(request, { resolveFile: async () => oldFile })) as never,
    })).resolves.toBe(true)
    const shown = runtime().entries.map(entry => entryTextContent(entry))
    for (const prompt of oldPrompts) expect(shown).toContain(prompt)
  })
})
