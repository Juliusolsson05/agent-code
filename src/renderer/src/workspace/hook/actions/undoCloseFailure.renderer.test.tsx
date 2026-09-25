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
  expect(showToast).toHaveBeenCalledWith('Could not restore "Fix the picker": Session failed to start. Check provider setup and retry.')
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
  expect(showToast).toHaveBeenCalledWith('Could not restore "Older": Session failed to start. Check provider setup and retry.')
  expect(JSON.stringify(showToast.mock.calls)).not.toContain('posix_spawnp')
  mounted.unmount()
})
