import { act, render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

import { useUndoCloseAction } from '@renderer/workspace/hook/actions/undoClose'
import { makeRefs, sessionActionsWithSpawn, stateWriter } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import { MissingWorkspaceDirectoryError } from '@main/workspaceDirectory'
import { freshStage } from '@renderer/workspace/dispatch/gridShape'
import type { WorkspaceState } from '@renderer/workspace/types'

// #1242: a failed respawn used to be swallowed (`catch { return null }`); the
// entry went back on the stack and nothing was shown, so after a CLI broke,
// every Cmd+Shift+T silently did nothing. The recorded spawn failure is the
// real IPC rejection from the incident journal.
const recorded = (JSON.parse(readFileSync(join(import.meta.dirname,
  '../../../../../../testing/fixtures/spawn-failure/posix-spawnp-2026-09-23.json'), 'utf8')) as { reason: string }).reason

function setup() {
  const state: WorkspaceState = {
    tabs: [{ id: 'tab-parent', title: 'agent-code' }], activeTabId: 'tab-parent', stage: freshStage(),
    sessions: {}, pinnedSessionIds: [],
  }
  const refs = makeRefs(state)
  const writer = stateWriter(state, refs)
  refs.undoStackRef.current.push({
    type: 'session', closedAt: Date.now(), sessionId: 'closed-pane',
    sessionMeta: { cwd: '/projects/agent-code', kind: 'claude', title: 'Fix the picker', projectId: 'tab-parent', joinedAt: 1 },
  })
  return { state, refs, writer }
}

it('says why an undo-close restore failed, and keeps the entry for another try', async () => {
  const { state, refs, writer } = setup()
  const spawn = vi.fn().mockRejectedValue(new Error(recorded))
  const showToast = vi.fn()
  let actions!: ReturnType<typeof useUndoCloseAction>
  function Harness(): React.JSX.Element {
    actions = useUndoCloseAction(state, writer.setState, refs, sessionActionsWithSpawn(spawn), showToast)
    return <div />
  }
  const mounted = render(<Harness />)
  await act(async () => { await actions.undoClose() })
  // Long enough to read: warning-grade toasts use 6-10 s, not the 2.5 s default.
  expect(showToast).toHaveBeenCalledWith('Could not restore "Fix the picker": Session failed to start. Check provider setup and retry.', 8000)
  // Never the raw IPC rejection: it can carry environment values or tokens.
  expect(JSON.stringify(showToast.mock.calls)).not.toContain('posix_spawnp')
  expect(refs.undoStackRef.current.length).toBe(1)
  mounted.unmount()
})

it('says which part of a group could not come back when the rest did', async () => {
  const { state, refs, writer } = setup()
  refs.undoStackRef.current.pop()
  const member = (id: string, title: string) => ({
    type: 'session' as const, closedAt: Date.now(), sessionId: id,
    sessionMeta: { cwd: '/projects/agent-code', kind: 'claude' as const, title, projectId: 'tab-parent', joinedAt: 1 },
  })
  refs.undoStackRef.current.push({ type: 'group', closedAt: Date.now(), entries: [member('a', 'Older'), member('b', 'Newer')] } as never)
  // The newest member restores, the older one fails.
  const spawn = vi.fn().mockResolvedValueOnce('restored-b').mockRejectedValueOnce(new Error(recorded))
  const showToast = vi.fn()
  let actions!: ReturnType<typeof useUndoCloseAction>
  function Harness(): React.JSX.Element {
    actions = useUndoCloseAction(state, writer.setState, refs, sessionActionsWithSpawn(spawn), showToast)
    return <div />
  }
  const mounted = render(<Harness />)
  await act(async () => { await actions.undoClose() })
  expect(showToast).toHaveBeenCalledWith('Could not restore "Older": Session failed to start. Check provider setup and retry.', 8000)
  expect(JSON.stringify(showToast.mock.calls)).not.toContain('posix_spawnp')
  mounted.unmount()
})

function mount(state: WorkspaceState, refs: ReturnType<typeof makeRefs>, writer: ReturnType<typeof stateWriter>, spawn: ReturnType<typeof vi.fn>) {
  const showToast = vi.fn()
  let actions!: ReturnType<typeof useUndoCloseAction>
  function Harness(): React.JSX.Element {
    actions = useUndoCloseAction(state, writer.setState, refs, sessionActionsWithSpawn(spawn), showToast)
    return <div />
  }
  const mounted = render(<Harness />)
  return { showToast, undo: () => actions.undoClose(), unmount: () => mounted.unmount() }
}

it('names an untitled agent by its folder, as the rest of the app does (#1264 review)', async () => {
  const { state, refs, writer } = setup()
  refs.undoStackRef.current.pop()
  // 19 of the owner's 35 real sessions have no title.
  refs.undoStackRef.current.push({
    type: 'session', closedAt: Date.now(), sessionId: 'untitled',
    sessionMeta: { cwd: '/projects/agent-code/', kind: 'claude', projectId: 'tab-parent', joinedAt: 1 },
  })
  const harness = mount(state, refs, writer, vi.fn().mockRejectedValue(new Error(recorded)))
  await act(async () => { await harness.undo() })
  expect(harness.showToast).toHaveBeenCalledWith('Could not restore "agent-code": Session failed to start. Check provider setup and retry.', 8000)
  harness.unmount()
})

it('says how many agents of a restored project did not come back (#1264 review)', async () => {
  const { state, refs, writer } = setup()
  refs.undoStackRef.current.pop()
  const meta = (title: string) => ({ cwd: '/projects/agent-code', kind: 'claude' as const, title, projectId: 'closed-tab', joinedAt: 1 })
  refs.undoStackRef.current.push({
    type: 'tab', closedAt: Date.now(), tab: { id: 'closed-tab', title: 'agent-code' }, tabIndex: 0,
    sessions: [{ sessionId: 'one', meta: meta('One') }, { sessionId: 'two', meta: meta('Two') }, { sessionId: 'three', meta: meta('Three') }],
  })
  const spawn = vi.fn().mockResolvedValueOnce('new-one').mockRejectedValueOnce(new Error(recorded)).mockResolvedValueOnce('new-three')
  const harness = mount(state, refs, writer, spawn)
  await act(async () => { await harness.undo() })
  expect(harness.showToast).toHaveBeenCalledWith('Could not restore 1 of 3 agents in project "agent-code": Session failed to start. Check provider setup and retry.', 8000)
  harness.unmount()
})

it('names the project when none of its agents came back', async () => {
  const { state, refs, writer } = setup()
  refs.undoStackRef.current.pop()
  refs.undoStackRef.current.push({
    type: 'tab', closedAt: Date.now(), tab: { id: 'closed-tab', title: 'agent-code' }, tabIndex: 0,
    sessions: [{ sessionId: 'one', meta: { cwd: '/projects/agent-code', kind: 'claude', projectId: 'closed-tab', joinedAt: 1 } }],
  })
  const harness = mount(state, refs, writer, vi.fn().mockRejectedValue(new Error(recorded)))
  await act(async () => { await harness.undo() })
  expect(harness.showToast).toHaveBeenCalledWith('Could not restore project "agent-code": Session failed to start. Check provider setup and retry.', 8000)
  harness.unmount()
})

// #1264 review B R2-1: a worktree removed after its branch merged. Main refuses
// the spawn with MissingWorkspaceDirectoryError; ipcRenderer.invoke relays it
// as Electron's `Error invoking remote method '<channel>': ${String(error)}`
// wrapper, built here from the real class so a change to main's message fails
// this test. No journal holds one (the undo stack is in-memory), hence built,
// not recorded. Before the fix the entry was pushed back forever and the older
// close below was unreachable.
it('consumes a close whose folder is gone, says so, and restores the older close', async () => {
  const { state, refs, writer } = setup()
  const gone = '/projects/agent-code/.worktrees/merged-branch'
  refs.undoStackRef.current.push({
    type: 'session', closedAt: Date.now(), sessionId: 'gone-pane',
    sessionMeta: { cwd: gone, kind: 'claude', title: 'Merged work', projectId: 'tab-parent', joinedAt: 2 },
  })
  const relayed = `Error invoking remote method 'session:spawn': ${String(new MissingWorkspaceDirectoryError(gone))}`
  const spawn = vi.fn().mockRejectedValueOnce(new Error(relayed)).mockResolvedValueOnce('restored-older')
  const harness = mount(state, refs, writer, spawn)
  await act(async () => { await harness.undo() })
  expect(harness.showToast).toHaveBeenCalledWith(`Could not restore "Merged work": its folder no longer exists (${gone})`, 8000)
  expect(spawn).toHaveBeenCalledTimes(2)
  expect(refs.undoStackRef.current.length).toBe(0)
  expect(Object.keys(refs.stateRef.current.sessions)).toContain('restored-older')
  harness.unmount()
})

it('consumes a project whose every folder is gone instead of retrying it forever', async () => {
  const { state, refs, writer } = setup()
  refs.undoStackRef.current.pop()
  const gone = '/projects/agent-code/.worktrees/merged-branch'
  refs.undoStackRef.current.push({
    type: 'tab', closedAt: Date.now(), tab: { id: 'closed-tab', title: 'merged-branch' }, tabIndex: 0,
    sessions: [{ sessionId: 'one', meta: { cwd: gone, kind: 'claude', projectId: 'closed-tab', joinedAt: 1 } }],
  })
  const relayed = `Error invoking remote method 'session:spawn': ${String(new MissingWorkspaceDirectoryError(gone))}`
  const harness = mount(state, refs, writer, vi.fn().mockRejectedValue(new Error(relayed)))
  await act(async () => { await harness.undo() })
  expect(harness.showToast).toHaveBeenCalledWith(`Could not restore project "merged-branch": its folder no longer exists (${gone})`, 8000)
  expect(refs.undoStackRef.current.length).toBe(0)
  harness.unmount()
})

// Round-2 review (both reviewers' surviving mutant): one deleted worktree must
// not consume a project whose other agents can come back, and the toast must
// not blame the provider for the deleted folder.
it('restores the agents that can come back when only some folders are gone', async () => {
  const { state, refs, writer } = setup()
  refs.undoStackRef.current.pop()
  const gone = '/projects/agent-code/.worktrees/merged-branch'
  refs.undoStackRef.current.push({
    type: 'tab', closedAt: Date.now(), tab: { id: 'closed-tab', title: 'agent-code' }, tabIndex: 0,
    sessions: [
      { sessionId: 'gone', meta: { cwd: gone, kind: 'claude', projectId: 'closed-tab', joinedAt: 1 } },
      { sessionId: 'fine', meta: { cwd: '/projects/agent-code', kind: 'claude', projectId: 'closed-tab', joinedAt: 2 } },
    ],
  })
  const relayed = `Error invoking remote method 'session:spawn': ${String(new MissingWorkspaceDirectoryError(gone))}`
  const spawn = vi.fn().mockRejectedValueOnce(new Error(relayed)).mockResolvedValueOnce('restored-fine')
  const harness = mount(state, refs, writer, spawn)
  await act(async () => { await harness.undo() })
  expect(Object.keys(refs.stateRef.current.sessions)).toContain('restored-fine')
  expect(harness.showToast).toHaveBeenCalledWith('Could not restore 1 of 2 agents in project "agent-code": their folders no longer exist', 8000)
  harness.unmount()
})

it('names no single folder when a gone project spanned several', async () => {
  const { state, refs, writer } = setup()
  refs.undoStackRef.current.pop()
  const meta = (cwd: string) => ({ cwd, kind: 'claude' as const, projectId: 'closed-tab', joinedAt: 1 })
  refs.undoStackRef.current.push({
    type: 'tab', closedAt: Date.now(), tab: { id: 'closed-tab', title: 'agent-code' }, tabIndex: 0,
    sessions: [{ sessionId: 'a', meta: meta('/gone/one') }, { sessionId: 'b', meta: meta('/gone/two') }],
  })
  const spawn = vi.fn(async (cwd: string) => {
    throw new Error(`Error invoking remote method 'session:spawn': ${String(new MissingWorkspaceDirectoryError(cwd))}`)
  })
  const harness = mount(state, refs, writer, spawn)
  await act(async () => { await harness.undo() })
  expect(harness.showToast).toHaveBeenCalledWith('Could not restore project "agent-code": their folders no longer exist', 8000)
  expect(refs.undoStackRef.current.length).toBe(0)
  harness.unmount()
})

it('does not push a deleted-folder member back with its group when a sibling fails to start', async () => {
  const { state, refs, writer } = setup()
  refs.undoStackRef.current.pop()
  const member = (id: string, title: string, cwd: string) => ({
    type: 'session' as const, closedAt: Date.now(), sessionId: id,
    sessionMeta: { cwd, kind: 'claude' as const, title, projectId: 'tab-parent', joinedAt: 1 },
  })
  const gone = '/projects/agent-code/.worktrees/merged-branch'
  refs.undoStackRef.current.push({ type: 'group', closedAt: Date.now(), entries: [member('p', 'ProviderDown', '/projects/agent-code'), member('f', 'FolderGone', gone)] } as never)
  const spawn = vi.fn()
    .mockRejectedValueOnce(new Error(`Error invoking remote method 'session:spawn': ${String(new MissingWorkspaceDirectoryError(gone))}`))
    .mockRejectedValueOnce(new Error(recorded))
  const harness = mount(state, refs, writer, spawn)
  await act(async () => { await harness.undo() })
  const left = refs.undoStackRef.current.pop()
  expect(left?.type).toBe('session')
  expect(left?.type === 'session' ? left.sessionMeta.title : null).toBe('ProviderDown')
  expect(harness.showToast).toHaveBeenLastCalledWith('Could not restore "ProviderDown": Session failed to start. Check provider setup and retry.', 8000)
  harness.unmount()
})
