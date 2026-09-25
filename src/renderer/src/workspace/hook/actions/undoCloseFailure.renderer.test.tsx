import { act, render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

import { useUndoCloseAction } from '@renderer/workspace/hook/actions/undoClose'
import { makeRefs, sessionActionsWithSpawn, stateWriter } from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
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
