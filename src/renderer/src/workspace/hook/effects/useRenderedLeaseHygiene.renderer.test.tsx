import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/hooks'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { Workspace } from '@renderer/workspace/workspaceStore'

import { useRenderedLeaseHygiene } from './useRenderedLeaseHygiene'

// Sidekick Spotlight hides the lanes (#1493 follow-up). Review of #1513: a
// lane Copy Assistant picker left open took Enter from the spotlit Sidekick's
// composer, because useKeybinds' picker handlers run before the Sidekick
// region gate. The hygiene effect is what removes the hidden picker; the
// sidekick's own picker must survive, since the Sidekick is on screen.

const original = useAppStore.getState()
afterEach(() => { useAppStore.setState(original, true) })

function Harness({ workspace }: { workspace: Workspace }) {
  useRenderedLeaseHygiene(workspace)
  return null
}

function fakeWorkspace() {
  const picker = { uuid: 'u', index: 0 }
  const runtimes = {
    lane: { ...emptyRuntime(), assistantPicker: picker },
    sk: { ...emptyRuntime(), assistantPicker: picker },
  }
  useAppStore.setState({ workspaceRuntimes: runtimes as never })
  return {
    runtimes,
    state: { sessions: { lane: { kind: 'claude', cwd: '/repo' }, sk: { kind: 'claude', cwd: '/home', sidekickId: 'side' } } },
    readerMode: null,
    spotlight: null,
    pickerCancel: vi.fn(),
    setCodeBlockPicker: vi.fn(),
    releaseRenderedViewLease: vi.fn(),
    releaseAllRenderedViewLeases: vi.fn(),
  } as unknown as Workspace & { pickerCancel: ReturnType<typeof vi.fn> }
}

describe('rendered lease hygiene under Sidekick Spotlight', () => {
  it('cancels the hidden lanes\' pickers but not the spotlit sidekick\'s', () => {
    const workspace = fakeWorkspace()
    useAppStore.setState({ sidekickSpotlight: true })
    render(<Harness workspace={workspace} />)
    expect(workspace.pickerCancel).toHaveBeenCalledWith('lane')
    expect(workspace.pickerCancel).not.toHaveBeenCalledWith('sk')
  })

  it('leaves every picker alone when nothing hides the lanes', () => {
    const workspace = fakeWorkspace()
    useAppStore.setState({ sidekickSpotlight: false })
    render(<Harness workspace={workspace} />)
    expect(workspace.pickerCancel).not.toHaveBeenCalled()
  })
})
