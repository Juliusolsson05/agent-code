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
      activeTab: {
        id: 'tab-1',
        title: 'Project',
        focusedSessionId: 'parent',
        root: { type: 'leaf', sessionId: 'parent' },
      },
      dispatchMode: { focusedSessionId: 'parent' },
      state: {
        activeTabId: 'tab-1',
        tabs: [{
          id: 'tab-1',
          title: 'Project',
          focusedSessionId: 'parent',
          root: { type: 'leaf', sessionId: 'parent' },
        }],
        sessions: { parent: { cwd: '/project', kind: 'claude' } },
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
        attachIntent={null}
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
      activeTab: { id: 'tab-1', title: 'Project', focusedSessionId: 'parent', root: { type: 'leaf', sessionId: 'parent' } },
      dispatchMode: { focusedSessionId: 'parent' },
      state: {
        activeTabId: 'tab-1',
        tabs: [{ id: 'tab-1', title: 'Project', focusedSessionId: 'parent', root: { type: 'leaf', sessionId: 'parent' } }],
        sessions: { parent: { cwd: '/project', kind: 'claude' } },
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
        attachIntent={null} linkedAgentParentId={null} projectIntent={projectIntent} />,
    )
    fireEvent.click(screen.getByText('Terminal').closest('button')!)
    expect(createDetachedDispatchAgent).toHaveBeenCalledWith({ kind: 'terminal', providerRuntime: undefined }, projectIntent)
    expect(workspace.splitFocused).not.toHaveBeenCalled()
  })
})
