import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionSpawnOptions } from '@preload/api/types'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import { mergeProjectTabs } from '@renderer/workspace/mergeProjectTabs'
import { useSessionActions } from './session'
import { makeRefs, stateWriter } from './testing/paneActionsHarness'
import type { SessionMeta, WorkspaceState } from '@renderer/workspace/types'

// #1282: Reload Agents (Dangerous Agents toggle) walked a snapshot and
// re-checked nothing across its awaits. The workspace is the owner's
// sanitized persisted v3 workspace (a Claude and a Codex lane agent); the
// spawn IPC is the one mocked edge, and it is held open so the test can
// change the workspace while the reload is mid-flight, as a user can.

vi.mock('./initialHistory', () => ({ loadInitialHistoryForSession: vi.fn(async () => undefined) }))
const originalApi = window.api
afterEach(() => { cleanup(); window.api = originalApi })

const persisted = JSON.parse(readFileSync(
  join(import.meta.dirname, '../../../../../../testing/fixtures/workspace-v3/2026-09-20-live-workspace.sanitized.json'), 'utf8',
)) as { windows: Array<{ workspace: {
  projects: Array<{ id: string; title: string }>
  activeProjectId: string
  stage: WorkspaceState['stage']
  sessions: Record<string, SessionMeta>
} }> }

function harness(heldKind: 'claude' | 'codex' = 'claude', opts: { heldSpawnRejects?: boolean } = {}) {
  const recorded = persisted.windows[0]!.workspace
  const [claudeLane, codexLane] = recorded.stage.lanes.map(lane => lane.selectedSessionId!) as [string, string]
  const state = {
    tabs: recorded.projects,
    activeTabId: recorded.activeProjectId,
    sessions: recorded.sessions,
    pinnedSessionIds: [],
    stage: recorded.stage,
  } as unknown as WorkspaceState
  const refs = makeRefs(state), writer = stateWriter(state, refs)
  refs.latestRuntimesRef.current = {
    [claudeLane]: { ...emptyRuntime(), processStatus: 'started', draftInput: 'before' },
    [codexLane]: { ...emptyRuntime(), processStatus: 'started' },
  }
  const setRuntimes = (update: Record<string, SessionRuntime> | ((prev: Record<string, SessionRuntime>) => Record<string, SessionRuntime>)) => {
    refs.latestRuntimesRef.current = typeof update === 'function' ? update(refs.latestRuntimesRef.current) : update
  }
  // The Claude respawn is held until the test releases it.
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const spawnSession = vi.fn(async (options: SessionSpawnOptions) => {
    if (options.kind === heldKind) {
      await held
      if (opts.heldSpawnRejects) throw new Error('spawn failed')
    }
    // A safe (dangerous-off) respawn gets its own id so two overlapping
    // reloads' successors can be told apart.
    const suffix = options.dangerousMode === false ? 'safe' : 'restarted'
    return { sessionId: `${options.kind}-${suffix}`, providerSessionId: options.resumeSessionId }
  })
  // Kills resolve immediately unless the test installs a hold for one id.
  const killHolds = new Map<string, Promise<boolean>>()
  const killOwnedSession = vi.fn(async (req: { sessionId: string }) => killHolds.get(req.sessionId) ?? true)
  window.api = { ...originalApi, spawnSession, killOwnedSession, controlGoalLoop: vi.fn(async () => null), carryGoalLoop: vi.fn(async () => null) }
  const hook = renderHook(() => useSessionActions(state, writer.setState, setRuntimes, refs))
  // The Claude agent is first in the snapshot, so it is the one in flight.
  const order = Object.keys(recorded.sessions).filter(id => id === claudeLane || id === codexLane)
  return { hook, writer, refs, spawnSession, killOwnedSession, killHolds, release, claudeLane, codexLane, order }
}

it('does not bring back an agent closed while its respawn was in flight', async () => {
  const h = harness()
  let reload!: Promise<void>
  await act(async () => { reload = h.hook.result.current.reloadAgentSessions(true) })
  await vi.waitFor(() => expect(h.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ kind: 'claude' })))
  // The user closes the Claude agent while it is respawning.
  h.writer.setState(prev => {
    const sessions = { ...prev.sessions }
    delete sessions[h.claudeLane]
    return { ...prev, sessions }
  })
  await act(async () => { h.release(); await reload })
  const after = h.writer.getState()
  expect(after.sessions['claude-restarted']).toBeUndefined()
  expect(after.sessions[h.claudeLane]).toBeUndefined()
  // Its new process is not left running unowned.
  expect(h.killOwnedSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'claude-restarted', caller: 'reload.orphaned-successor' }))
})

it('does not double an agent replaced while its respawn was in flight', async () => {
  const h = harness()
  let reload!: Promise<void>
  await act(async () => { reload = h.hook.result.current.reloadAgentSessions(true) })
  await vi.waitFor(() => expect(h.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ kind: 'claude' })))
  // A provider switch replaced the same agent meanwhile.
  h.writer.setState(prev => {
    const sessions = { ...prev.sessions }
    const meta = sessions[h.claudeLane]!
    delete sessions[h.claudeLane]
    sessions['switched-successor'] = meta
    return { ...prev, sessions }
  })
  await act(async () => { h.release(); await reload })
  const after = h.writer.getState()
  expect(after.sessions['switched-successor']).toBeDefined()
  expect(after.sessions['claude-restarted']).toBeUndefined()
  expect(h.killOwnedSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'claude-restarted', caller: 'reload.orphaned-successor' }))
})

it('skips an agent closed before the reload reached it', async () => {
  const h = harness()
  const second = h.order[1]!
  const secondKind = h.writer.getState().sessions[second]!.kind
  let reload!: Promise<void>
  await act(async () => { reload = h.hook.result.current.reloadAgentSessions(true) })
  await vi.waitFor(() => expect(h.spawnSession).toHaveBeenCalledTimes(1))
  h.writer.setState(prev => {
    const sessions = { ...prev.sessions }
    delete sessions[second]
    return { ...prev, sessions }
  })
  await act(async () => { h.release(); await reload })
  expect(h.spawnSession).not.toHaveBeenCalledWith(expect.objectContaining({ kind: secondKind }))
  expect(h.spawnSession).toHaveBeenCalledTimes(1)
})

it('keeps a draft typed, and an unread marker set, while the reload ran', async () => {
  const h = harness()
  let reload!: Promise<void>
  await act(async () => { reload = h.hook.result.current.reloadAgentSessions(true) })
  await vi.waitFor(() => expect(h.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ kind: 'claude' })))
  h.refs.latestRuntimesRef.current = {
    ...h.refs.latestRuntimesRef.current,
    [h.claudeLane]: { ...h.refs.latestRuntimesRef.current[h.claudeLane]!, draftInput: 'typed during the reload', draftImages: [{ id: 'img-1' } as never], unreadSince: 1234, unreadKind: 'output' as never },
  }
  await act(async () => { h.release(); await reload })
  expect(h.refs.latestRuntimesRef.current['claude-restarted']).toMatchObject({
    draftInput: 'typed during the reload',
    draftImages: [{ id: 'img-1' }],
    unreadSince: 1234,
    unreadKind: 'output',
  })
})

// An agent respawned EARLY in the loop can be closed while a later one's
// spawn is in flight; the commit must re-check it too.
it('does not file an early agent closed while a later agent was respawning', async () => {
  const probe = harness()
  const [first, second] = probe.order as [string, string]
  cleanup()
  const secondKind = probe.writer.getState().sessions[second]!.kind as 'claude' | 'codex'
  const firstKind = probe.writer.getState().sessions[first]!.kind as string
  const h = harness(secondKind)
  let reload!: Promise<void>
  await act(async () => { reload = h.hook.result.current.reloadAgentSessions(true) })
  await vi.waitFor(() => expect(h.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ kind: secondKind })))
  h.writer.setState(prev => {
    const sessions = { ...prev.sessions }
    delete sessions[first]
    return { ...prev, sessions }
  })
  await act(async () => { h.release(); await reload })
  expect(h.writer.getState().sessions[`${firstKind}-restarted`]).toBeUndefined()
  expect(h.killOwnedSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: `${firstKind}-restarted`, caller: 'reload.orphaned-successor' }))
})

// #1326 review A1: the Dangerous Agents switch does not serialize clicks, so
// on -> off can start a second reload before the first settles. The last
// click must win: the safe successors are filed, the dangerous ones are not.
it('lets the later of two overlapping reloads decide the final mode', async () => {
  const h = harness()
  let on!: Promise<void>, off!: Promise<void>
  await act(async () => {
    on = h.hook.result.current.reloadAgentSessions(true)
    off = h.hook.result.current.reloadAgentSessions(false)
  })
  await vi.waitFor(() => expect(h.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ kind: 'claude' })))
  await act(async () => { h.release(); await on; await off })
  const sessions = h.writer.getState().sessions
  expect(sessions['claude-safe']).toBeDefined()
  expect(sessions['codex-safe']).toBeDefined()
  expect(sessions['claude-restarted']).toBeUndefined()
  expect(sessions['codex-restarted']).toBeUndefined()
  // The dangerous successors were reloaded away, not left running.
  expect(h.killOwnedSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'claude-restarted' }))
  expect(h.killOwnedSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'codex-restarted' }))
})

// #1326 review A2: a project merge keeps the session id but re-files it under
// the target project and deletes the source. The successor must follow it.
it('files the successor under the project an agent was merged into mid-reload', async () => {
  const h = harness()
  const source = h.writer.getState().sessions[h.claudeLane]!.projectId!
  const target = h.writer.getState().tabs.find(tab => tab.id !== source)!.id
  let reload!: Promise<void>
  await act(async () => { reload = h.hook.result.current.reloadAgentSessions(true) })
  await vi.waitFor(() => expect(h.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ kind: 'claude' })))
  h.writer.setState(prev => {
    const merged = mergeProjectTabs(prev, { sourceTabIds: [source], targetTabId: target, now: Date.now() })
    if (!merged.ok) throw new Error(merged.reason)
    return merged.state
  })
  await act(async () => { h.release(); await reload })
  expect(h.writer.getState().sessions['claude-restarted']?.projectId).toBe(target)
})

// #1326 review A3/B1: orphan kills used to be awaited INSIDE the commit-time
// check loop, so a close during one was never re-checked. The commit must be
// done, with no await, before any orphan kill starts.
it('commits before it awaits any orphan kill', async () => {
  const probe = harness()
  const [first, second] = probe.order as [string, string]
  cleanup()
  const secondKind = probe.writer.getState().sessions[second]!.kind as 'claude' | 'codex'
  const firstKind = probe.writer.getState().sessions[first]!.kind as string
  const h = harness(secondKind)
  let releaseKill!: (value: boolean) => void
  h.killHolds.set(`${secondKind}-restarted`, new Promise<boolean>(resolve => { releaseKill = resolve }))
  let reload!: Promise<void>
  await act(async () => { reload = h.hook.result.current.reloadAgentSessions(true) })
  await vi.waitFor(() => expect(h.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ kind: secondKind })))
  // The second agent is closed while its own respawn is in flight.
  h.writer.setState(prev => {
    const sessions = { ...prev.sessions }
    delete sessions[second]
    return { ...prev, sessions }
  })
  await act(async () => { h.release() })
  await vi.waitFor(() => expect(h.killOwnedSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: `${secondKind}-restarted` })))
  // While that orphan's kill is still pending, the first agent is already
  // committed under its successor id; a close now targets that live row.
  expect(h.writer.getState().sessions[`${firstKind}-restarted`]).toBeDefined()
  expect(h.writer.getState().sessions[first]).toBeUndefined()
  await act(async () => { releaseKill(true); await reload })
})

// #1326 review A4: a rejected orphan kill must neither abort the reload nor
// strand the other successor unfiled.
it('files the other successors when an orphan kill rejects', async () => {
  const probe = harness()
  const [first, second] = probe.order as [string, string]
  cleanup()
  const secondKind = probe.writer.getState().sessions[second]!.kind as 'claude' | 'codex'
  const firstKind = probe.writer.getState().sessions[first]!.kind as string
  const h = harness(secondKind)
  h.killHolds.set(`${secondKind}-restarted`, Promise.reject(new Error('kill IPC failed')))
  h.killHolds.get(`${secondKind}-restarted`)!.catch(() => undefined)
  let reload!: Promise<void>
  await act(async () => { reload = h.hook.result.current.reloadAgentSessions(true) })
  await vi.waitFor(() => expect(h.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ kind: secondKind })))
  h.writer.setState(prev => {
    const sessions = { ...prev.sessions }
    delete sessions[second]
    return { ...prev, sessions }
  })
  await act(async () => { h.release(); await reload })
  expect(h.writer.getState().sessions[`${firstKind}-restarted`]).toBeDefined()
  expect(h.writer.getState().sessions[`${secondKind}-restarted`]).toBeUndefined()
})

// #1326 review A5: a failed respawn of an agent closed meanwhile has no pane
// to show `failed` in; it must not recreate a runtime under the closed id.
it('does not recreate a runtime for a closed agent whose respawn failed', async () => {
  const h = harness('claude', { heldSpawnRejects: true })
  let reload!: Promise<void>
  await act(async () => { reload = h.hook.result.current.reloadAgentSessions(true) })
  await vi.waitFor(() => expect(h.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ kind: 'claude' })))
  h.writer.setState(prev => {
    const sessions = { ...prev.sessions }
    delete sessions[h.claudeLane]
    return { ...prev, sessions }
  })
  const runtimes = { ...h.refs.latestRuntimesRef.current }
  delete runtimes[h.claudeLane]
  h.refs.latestRuntimesRef.current = runtimes
  await act(async () => { h.release(); await reload })
  expect(h.refs.latestRuntimesRef.current[h.claudeLane]).toBeUndefined()
})

// #1326 review mutation survivors: the same id can stop being "the agent we
// set out to reload" without its row disappearing, by a cwd change or by its
// project going away. Each must orphan the successor.
it.each([
  ['its cwd changed', (prev: WorkspaceState, id: string) => ({
    ...prev, sessions: { ...prev.sessions, [id]: { ...prev.sessions[id]!, cwd: `${prev.sessions[id]!.cwd}-moved` } },
  })],
  ['its project was removed', (prev: WorkspaceState, id: string) => ({
    ...prev, tabs: prev.tabs.filter(tab => tab.id !== prev.sessions[id]!.projectId),
  })],
])('does not file a successor when %s mid-reload', async (_label, change) => {
  const h = harness()
  let reload!: Promise<void>
  await act(async () => { reload = h.hook.result.current.reloadAgentSessions(true) })
  await vi.waitFor(() => expect(h.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ kind: 'claude' })))
  h.writer.setState(prev => change(prev, h.claudeLane))
  await act(async () => { h.release(); await reload })
  expect(h.writer.getState().sessions['claude-restarted']).toBeUndefined()
  expect(h.killOwnedSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'claude-restarted', caller: 'reload.orphaned-successor' }))
})
