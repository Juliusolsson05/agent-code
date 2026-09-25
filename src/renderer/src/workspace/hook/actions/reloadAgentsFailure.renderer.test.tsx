import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionSpawnOptions } from '@preload/api/types'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import { useSessionActions } from './session'
import { makeRefs, stateWriter } from './testing/paneActionsHarness'
import type { SessionMeta, WorkspaceState } from '@renderer/workspace/types'
import { SESSION_START_FAILED_MESSAGE } from '@shared/types/session'
import { resolveReadinessText } from '@renderer/workspace/tile-tree/TileLeaf/readiness'

// #1239: toggling Dangerous Agents By Default reloads every live agent. An
// agent whose respawn failed used to be DELETED from the workspace (and its
// project, if it left one empty) with no message, after its backend had
// already been killed. It must stay, marked failed with the reason, so the
// pane can Retry.
//
// Real data (quality plan §8):
// - the workspace is the owner's sanitized persisted v3 workspace (projects,
//   stage and the two real lane sessions: a Claude and a Codex agent);
// - the failure is the recorded spawn rejection from the incident journal
//   (`posix_spawnp failed`, the node-pty spawn-helper trap), as it reaches the
//   renderer through IPC.
// The spawn IPC is the one mocked edge: the Codex respawn succeeds, the Claude
// one rejects with the recorded error.

vi.mock('./initialHistory', () => ({ loadInitialHistoryForSession: vi.fn(async () => undefined) }))
const originalApi = window.api
afterEach(() => { cleanup(); window.api = originalApi; vi.useRealTimers() })

const persisted = JSON.parse(readFileSync(
  join(import.meta.dirname, '../../../../../../testing/fixtures/workspace-v3/2026-09-20-live-workspace.sanitized.json'), 'utf8',
)) as { windows: Array<{ workspace: {
  projects: Array<{ id: string; title: string }>
  activeProjectId: string
  stage: WorkspaceState['stage']
  sessions: Record<string, SessionMeta>
} }> }
const recordedFailure = JSON.parse(readFileSync(
  join(import.meta.dirname, '../../../../../../testing/fixtures/spawn-failure/posix-spawnp-2026-09-23.json'), 'utf8',
)) as { reason: string }

it('keeps an agent whose respawn failed, marked failed with the spawn error, and restarts the others', async () => {
  vi.useFakeTimers()
  const recorded = persisted.windows[0]!.workspace
  const [claudeLane, codexLane] = recorded.stage.lanes.map(lane => lane.selectedSessionId!)
  expect(recorded.sessions[claudeLane!]!.kind).toBe('claude')
  expect(recorded.sessions[codexLane!]!.kind).toBe('codex')
  const state = {
    tabs: recorded.projects,
    activeTabId: recorded.activeProjectId,
    sessions: recorded.sessions,
    // Pinned, so the failed agent must also stay in the Pinned list.
    pinnedSessionIds: [claudeLane],
    stage: recorded.stage,
  } as unknown as WorkspaceState
  const refs = makeRefs(state), writer = stateWriter(state, refs)
  // Both lane agents have a backend (reload restarts only those, #992). The
  // Claude one is a real live pane: input-ready, with a half-typed draft that
  // must survive, and a transcript reader that had already errored (the
  // paths in initialHistory/useIpcSubscriptions write this), which must not
  // hide the restart failure (#1252 review).
  refs.latestRuntimesRef.current = {
    [claudeLane!]: {
      ...emptyRuntime(),
      processStatus: 'started',
      inputReady: true,
      inputReadinessReason: 'ready',
      draftInput: 'half-typed',
      transcriptStatus: 'error',
      transcriptError: 'old reader stopped',
    },
    [codexLane!]: { ...emptyRuntime(), processStatus: 'started' },
  }
  const setRuntimes = (update: Record<string, SessionRuntime> | ((prev: Record<string, SessionRuntime>) => Record<string, SessionRuntime>)) => {
    refs.latestRuntimesRef.current = typeof update === 'function' ? update(refs.latestRuntimesRef.current) : update
  }
  const spawnSession = vi.fn(async (options: SessionSpawnOptions) => {
    if (options.kind === 'claude') throw new Error(recordedFailure.reason)
    return { sessionId: 'codex-restarted', providerSessionId: options.resumeSessionId }
  })
  window.api = { ...originalApi, spawnSession, killOwnedSession: vi.fn(async () => true), controlGoalLoop: vi.fn(async () => null) }
  const hook = renderHook(() => useSessionActions(state, writer.setState, setRuntimes, refs))

  await act(async () => { await hook.result.current.reloadAgentSessions(true); await vi.runAllTimersAsync() })

  const after = writer.getState()
  // The Codex agent restarted under a new id, in its lane.
  expect(after.sessions[codexLane!]).toBeUndefined()
  expect(after.stage.lanes[1]!.selectedSessionId).toBe('codex-restarted')
  // The Claude agent is still there, in its project and its lane...
  expect(after.sessions[claudeLane!]).toMatchObject({ projectId: recorded.sessions[claudeLane!]!.projectId })
  expect(after.stage.lanes[0]!.selectedSessionId).toBe(claudeLane)
  expect(after.tabs.map(tab => tab.id)).toEqual(recorded.projects.map(project => project.id))
  // ...and says what happened, with Retry's state and its draft.
  expect(after.pinnedSessionIds).toEqual([claudeLane])
  const failed = refs.latestRuntimesRef.current[claudeLane!]!
  expect(failed).toMatchObject({
    processStatus: 'failed',
    processError: SESSION_START_FAILED_MESSAGE,
    recoveryFailureCode: 'start-failed',
    inputReady: false,
    inputReadinessReason: null,
    draftInput: 'half-typed',
  })
  // The raw IPC rejection never reaches the pane: provider exceptions can
  // carry environment values and tokens (#1252 review A).
  expect(JSON.stringify(failed)).not.toContain('posix_spawnp')
  expect(resolveReadinessText(failed)).toBe(`${SESSION_START_FAILED_MESSAGE} (start-failed)`)
})
