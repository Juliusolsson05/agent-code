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

  // Plan M6: the list keys clamp (it wrapped), Home/End jump, the listbox owns
  // the highlight, and the keys are shown in the card's footer.
  it('clamps at the ends, jumps with End, announces the highlight, and shows its keys', () => {
    const createDetachedDispatchAgent = vi.fn(async () => undefined)
    const workspace = {
      activeTab: { id: 'tab-1', title: 'Project' },
      state: { activeTabId: 'tab-1', tabs: [{ id: 'tab-1', title: 'Project' }], sessions: {} },
      createDetachedDispatchAgent,
    } as unknown as Workspace
    render(<NewAgentPlacementOverlay open workspace={workspace} onClose={vi.fn()} linkedAgentParentId={null} projectIntent={null} />)
    const list = screen.getByRole('listbox', { name: 'Agent type' })
    expect(document.activeElement).toBe(list)
    fireEvent.keyDown(document, { key: 'ArrowUp' })
    expect(list).toHaveAttribute('aria-activedescendant', 'new-agent-kind-0') // clamped, not wrapped
    fireEvent.keyDown(document, { key: 'End' })
    const options = screen.getAllByRole('option')
    expect(list).toHaveAttribute('aria-activedescendant', `new-agent-kind-${options.length - 1}`)
    expect(screen.getByText('create')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Cancel' }).querySelector('[data-slot="kbd"]')?.textContent).toBe('⎋')
  })

  it('lets Enter on a focused Cancel cancel, and never create an agent (steering note k8)', () => {
    const createDetachedDispatchAgent = vi.fn(async () => undefined)
    const onClose = vi.fn()
    const workspace = {
      activeTab: { id: 'tab-1', title: 'Project' },
      state: { activeTabId: 'tab-1', tabs: [{ id: 'tab-1', title: 'Project' }], sessions: {} },
      createDetachedDispatchAgent,
    } as unknown as Workspace
    render(<NewAgentPlacementOverlay open workspace={workspace} onClose={onClose} linkedAgentParentId={null} projectIntent={null} />)
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    cancel.focus()
    // true = default NOT prevented, so the real browser still delivers
    // Cancel's click; happy-dom does not synthesize it, hence the click below.
    expect(fireEvent.keyDown(cancel, { key: 'Enter' })).toBe(true)
    expect(createDetachedDispatchAgent).not.toHaveBeenCalled()
    fireEvent.click(cancel)
    expect(onClose).toHaveBeenCalled()
    // Space on Cancel is untouched by the overlay's capture listener too.
    expect(fireEvent.keyDown(cancel, { key: ' ' })).toBe(true)
    // …and Enter from the list still creates.
    fireEvent.keyDown(screen.getByRole('listbox', { name: 'Agent type' }), { key: 'Enter' })
    expect(createDetachedDispatchAgent).toHaveBeenCalledOnce()
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

  // #1286 review B1: pin the slot's composition both ways. A takeover over a
  // SPLIT editor must still read hidden (the slot must not override the outer
  // value), and a split editor on its own must not hide the overlay.
  it('stands down under a takeover even when the editor is only split', async () => {
    const { RetainedWorkspaceSurface } = await import('@renderer/app/shell/RetainedWorkspaceSurface')
    const { GlobalEditorWorkspaceSlot } = await import('@renderer/features/global-editor/ui/GlobalEditorWorkspaceSlot')
    const create = vi.fn(async () => 'new-session')
    const onClose = vi.fn()
    const mounted = render(
      <RetainedWorkspaceSurface hidden>
        <GlobalEditorWorkspaceSlot open editorFullscreen={false} splitWorkspaceWidth="60%">
          <NewAgentPlacementOverlay open workspace={stubWorkspace(create)} onClose={onClose} linkedAgentParentId={null} projectIntent={null} />
        </GlobalEditorWorkspaceSlot>
      </RetainedWorkspaceSurface>,
    )
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(create).not.toHaveBeenCalled()
    // The request is kept for when the surface returns, not dismissed.
    expect(onClose).not.toHaveBeenCalled()
    mounted.unmount()
  })

  it('works beside a split editor with the workspace on screen', async () => {
    const { GlobalEditorWorkspaceSlot } = await import('@renderer/features/global-editor/ui/GlobalEditorWorkspaceSlot')
    const create = vi.fn(async () => 'new-session')
    const mounted = render(
      <GlobalEditorWorkspaceSlot open editorFullscreen={false} splitWorkspaceWidth="60%">
        <NewAgentPlacementOverlay open workspace={stubWorkspace(create)} onClose={vi.fn()} linkedAgentParentId={null} projectIntent={null} />
      </GlobalEditorWorkspaceSlot>,
    )
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    mounted.unmount()
  })

  // #1286 review B4: the latch's other outcomes.
  it('keeps the latch after a create that produced a session', async () => {
    const create = vi.fn(async () => 'new-session')
    const mounted = render(<NewAgentPlacementOverlay open workspace={stubWorkspace(create)} onClose={vi.fn()} linkedAgentParentId={null} projectIntent={null} />)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    await Promise.resolve(); await Promise.resolve()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await Promise.resolve(); await Promise.resolve()
    expect(create).toHaveBeenCalledTimes(1)
    mounted.unmount()
  })

  it('reopens the latch after a create that rejected', async () => {
    const create = vi.fn().mockRejectedValueOnce(new Error('spawn failed')).mockResolvedValueOnce('new-session')
    const mounted = render(<NewAgentPlacementOverlay open workspace={stubWorkspace(create)} onClose={vi.fn()} linkedAgentParentId={null} projectIntent={null} />)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    await Promise.resolve(); await Promise.resolve()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    mounted.unmount()
  })

  // #1286 review A2: an OLD create settling late must not reopen the latch
  // for a NEW create still in flight.
  it('does not let a stale create reopen the latch for a newer one', async () => {
    let failFirst!: () => void
    const first = new Promise<null>(resolve => { failFirst = () => resolve(null) })
    const create = vi.fn().mockReturnValueOnce(first).mockReturnValue(new Promise(() => {}))
    const workspace = stubWorkspace(create)
    const onClose = vi.fn()
    const mounted = render(<NewAgentPlacementOverlay open workspace={workspace} onClose={onClose} linkedAgentParentId={null} projectIntent={null} />)
    const enter = () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    enter()
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    // Close and reopen: the open effect resets the latch.
    mounted.rerender(<NewAgentPlacementOverlay open={false} workspace={workspace} onClose={onClose} linkedAgentParentId={null} projectIntent={null} />)
    mounted.rerender(<NewAgentPlacementOverlay open workspace={workspace} onClose={onClose} linkedAgentParentId={null} projectIntent={null} />)
    enter()
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2))
    failFirst()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    enter()
    await Promise.resolve(); await Promise.resolve()
    expect(create).toHaveBeenCalledTimes(2)
    mounted.unmount()
  })
})
