import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { NewAgentPlacementOverlay } from './NewAgentPlacementOverlay'
import type { Workspace } from '@renderer/workspace/workspaceStore'

beforeAll(() => {
  class NoopResizeObserver {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  }
  globalThis.ResizeObserver = NoopResizeObserver
})

describe('NewAgentPlacementOverlay OpenCode runtime choices', () => {
  it('shows OpenCode and OpenCode Terminal as separate agents and preserves the runtime choice', () => {
    const createDetachedDispatchAgent = vi.fn(async () => undefined)
    const onClose = vi.fn()
    const workspace = {
      activeTab: { id: 'tab-1', title: 'Project' },
      stage: { lanes: [{ selectedSessionId: 'parent' }], rows: [{ length: 1 }], focusedLane: 0 },
      state: {
        activeTabId: 'tab-1',
        tabs: [{
          id: 'tab-1',
          title: 'Project',
        }],
        sessions: { parent: { cwd: '/project', kind: 'claude', projectId: 'tab-1', joinedAt: 0 } },
      },
      createDetachedDispatchAgent,
      createLinkedAgent: vi.fn(),
      splitFocused: vi.fn(),
      commitNewAgentPlacement: vi.fn(),
      attachDetachedToGrid: vi.fn(),
    } as unknown as Workspace

    render(
      <NewAgentPlacementOverlay
        open
        workspace={workspace}
        onClose={onClose}
        linkedAgentParentId={null}
        projectIntent={null}
      />,
    )

    expect(screen.getByText('OpenCode')).toBeTruthy()
    const nativeChoice = screen.getByText('OpenCode Terminal')
    expect(nativeChoice).toBeTruthy()
    fireEvent.click(nativeChoice.closest('button')!)

    expect(createDetachedDispatchAgent).toHaveBeenCalledWith(
      { kind: 'opencode', providerRuntime: 'terminal' },
      undefined,
    )
    expect(onClose).not.toHaveBeenCalled()
  })

  it('offers Terminal in Dispatch and files it on the clicked project (#865)', () => {
    // The Dispatch picker filtered Terminal out ("no terminal option") from
    // before #671 made Dispatch terminals full detached rows; its commit path
    // even kept a dead terminal branch. A project-header "+" must also carry
    // its project, which the old splitFocused route could not.
    const createDetachedDispatchAgent = vi.fn(async () => undefined)
    const workspace = {
      activeTab: { id: 'tab-1', title: 'Project' },
      stage: { lanes: [{ selectedSessionId: 'parent' }], rows: [{ length: 1 }], focusedLane: 0 },
      state: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1', title: 'Project' }],
        sessions: { parent: { cwd: '/project', kind: 'claude', projectId: 'tab-1', joinedAt: 0 } },
      },
      createDetachedDispatchAgent,
      createLinkedAgent: vi.fn(),
      splitFocused: vi.fn(),
      commitNewAgentPlacement: vi.fn(),
      attachDetachedToGrid: vi.fn(),
    } as unknown as Workspace
    const projectIntent = { tabId: 'tab-1', anchorSessionId: 'parent' }

    render(
      <NewAgentPlacementOverlay open workspace={workspace} onClose={vi.fn()}
        linkedAgentParentId={null} projectIntent={projectIntent} />,
    )
    fireEvent.click(screen.getByText('Terminal').closest('button')!)
    expect(createDetachedDispatchAgent).toHaveBeenCalledWith({ kind: 'terminal', providerRuntime: undefined }, projectIntent)
    expect(workspace.splitFocused).not.toHaveBeenCalled()
  })
})

function stubWorkspace(createDetachedDispatchAgent: ReturnType<typeof vi.fn>): Workspace {
  return {
    activeTab: { id: 'tab-1', title: 'Project' },
    stage: { lanes: [{ selectedSessionId: 'parent' }], rows: [{ length: 1 }], focusedLane: 0 },
    state: {
      activeTabId: 'tab-1',
      tabs: [{ id: 'tab-1', title: 'Project' }],
      sessions: { parent: { cwd: '/project', kind: 'claude', projectId: 'tab-1', joinedAt: 0 } },
    },
    createDetachedDispatchAgent,
    createLinkedAgent: vi.fn(),
    splitFocused: vi.fn(),
    commitNewAgentPlacement: vi.fn(),
    attachDetachedToGrid: vi.fn(),
  } as unknown as Workspace
}

describe('NewAgentPlacementOverlay input ownership (C4 hunt)', () => {
  // #1269: the palette can open New Agent… under Spotlight/Reader or a
  // fullscreen editor, where the workspace is retained under display:none.
  // The overlay then owned Escape/arrows/Enter and stamped the app owner
  // marker (a querySelector, blind to display:none) while nothing showed.
  it('owns no input and no marker while its surface is hidden', async () => {
    const { RetainedWorkspaceSurface } = await import('@renderer/app/shell/RetainedWorkspaceSurface')
    const { hasAppInteractionOwner } = await import('@renderer/lib/interaction-ownership')
    const create = vi.fn(async () => 'new-session')
    const mounted = render(
      <RetainedWorkspaceSurface hidden>
        <NewAgentPlacementOverlay open workspace={stubWorkspace(create)} onClose={vi.fn()} linkedAgentParentId={null} projectIntent={null} />
      </RetainedWorkspaceSurface>,
    )
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    document.dispatchEvent(enter)
    expect(create).not.toHaveBeenCalled()
    expect(enter.defaultPrevented).toBe(false)
    expect(hasAppInteractionOwner()).toBe(false)
    mounted.unmount()
  })

  it('also stands down under a fullscreen editor', async () => {
    const { GlobalEditorWorkspaceSlot } = await import('@renderer/features/global-editor/ui/GlobalEditorWorkspaceSlot')
    const create = vi.fn(async () => 'new-session')
    const mounted = render(
      <GlobalEditorWorkspaceSlot open editorFullscreen splitWorkspaceWidth="60%">
        <NewAgentPlacementOverlay open workspace={stubWorkspace(create)} onClose={vi.fn()} linkedAgentParentId={null} projectIntent={null} />
      </GlobalEditorWorkspaceSlot>,
    )
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(create).not.toHaveBeenCalled()
    mounted.unmount()
  })

  // #1270: a failed create returns null and leaves the overlay open (the
  // toast says why), but the one-shot latch stayed set: Enter was dead while
  // the marker kept every shortcut blocked.
  it('lets the user retry after a create that failed', async () => {
    const create = vi.fn(async () => null)
    const mounted = render(
      <NewAgentPlacementOverlay open workspace={stubWorkspace(create)} onClose={vi.fn()} linkedAgentParentId={null} projectIntent={null} />,
    )
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    await Promise.resolve()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    mounted.unmount()
  })
})
