import { act } from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { useUndoCloseAction } from '@renderer/workspace/hook/actions/undoClose'
import {
  makeRefs,
  mountPaneActions,
  sessionActionsWithSpawn,
  stateWriter,
} from '@renderer/workspace/hook/actions/testing/paneActionsHarness'
import type { WorkspaceState, TiledDispatchState } from '@renderer/workspace/types'
import { freshStage } from '@renderer/workspace/dispatch/gridShape'

function makeState(stage: TiledDispatchState = freshStage()): WorkspaceState {
  return {
    tabs: [{
      id: 'tab-parent',
      title: 'parent',
    }],
    activeTabId: 'tab-parent',
    stage,
    sessions: {
      parent: { cwd: '/projects/parent', kind: 'codex', projectId: 'tab-parent', joinedAt: 0 },
    },
    pinnedSessionIds: [],
  } as WorkspaceState
}

describe('built-in MCP continuity at session resurrection boundaries', () => {

  it('keeps the explicit source cwd when Dispatch turns a split into a detached clone', async () => {
    const harness = mountPaneActions(makeState({ lanes: [{ selectedSessionId: 'parent' }], rows: [{ length: 1 }], focusedLane: 0 }))

    await act(async () => {
      await harness.actions.splitFocused('vertical', 'codex', {
        resumeSessionId: 'provider-clone',
        builtInMcpOverrides: { workflows: true },
        cwd: '/projects/related-child',
      })
    })

    expect(harness.spawn).toHaveBeenCalledWith('/projects/related-child', {
      kind: 'codex',
      resumeSessionId: 'provider-clone',
      builtInMcpOverrides: { workflows: true },
    })
    harness.mounted.unmount()
  })

  it('keeps the OpenCode terminal runtime when a transcript clone is spawned', async () => {
    // Re-based onto the stage (#992): cloning outside Dispatch used to split
    // the tile tree, and that branch no longer exists. The contract under test
    // is the spawn boundary, which is identical on the surviving path.
    const harness = mountPaneActions(makeState({ lanes: [{ selectedSessionId: 'parent' }], rows: [{ length: 1 }], focusedLane: 0 }))

    await act(async () => {
      await harness.actions.splitFocused('vertical', 'opencode', {
        resumeSessionId: 'ses_clone',
        builtInMcpOverrides: { orchestration: true },
        providerRuntime: 'terminal',
        cwd: '/projects/opencode-child',
      })
    })

    expect(harness.spawn).toHaveBeenCalledWith('/projects/opencode-child', {
      kind: 'opencode',
      providerRuntime: 'terminal',
      resumeSessionId: 'ses_clone',
      builtInMcpOverrides: { orchestration: true },
    })
    harness.mounted.unmount()
  })

  it('restores a closed session with fresh credentials derived from its captured domains', async () => {
    const state = makeState()
    const refs = makeRefs(state)
    const writer = stateWriter(state, refs)
    const spawn = vi.fn().mockResolvedValue('restored-pane')
    refs.undoStackRef.current.push({
      type: 'session',
      closedAt: Date.now(),
      sessionId: 'closed-pane',
      sessionMeta: {
        cwd: '/projects/related-child',
        kind: 'codex',
        providerSessionId: 'provider-old',
        builtInMcpDomains: ['workflows'],
        projectId: 'tab-parent',
        joinedAt: 1,
      },
    })
    let actions!: ReturnType<typeof useUndoCloseAction>

    function Harness(): React.JSX.Element {
      actions = useUndoCloseAction(state, writer.setState, refs, sessionActionsWithSpawn(spawn))
      return <div />
    }

    const mounted = render(<Harness />)
    await act(async () => {
      await actions.undoClose()
    })

    expect(spawn).toHaveBeenCalledWith('/projects/related-child', {
      kind: 'codex',
      resumeSessionId: 'provider-old',
      recoverTmuxName: undefined,
      builtInMcpOverrides: { workflows: true },
      tldrIdentity: undefined,
    })
    mounted.unmount()
  })

  it('restores an explicit all-off MCP selection instead of treating it as missing', async () => {
    const state = makeState()
    const refs = makeRefs(state)
    refs.defaultBuiltInMcpDomainsRef.current = ['orchestration']
    const writer = stateWriter(state, refs)
    const spawn = vi.fn().mockResolvedValue('restored-pane')
    refs.undoStackRef.current.push({
      type: 'session',
      closedAt: Date.now(),
      sessionId: 'closed-pane',
      sessionMeta: {
        cwd: '/projects/related-child',
        kind: 'codex',
        providerSessionId: 'provider-old',
        builtInMcpDomains: [],
        builtInMcpOverrides: { orchestration: false },
        projectId: 'tab-parent',
        joinedAt: 1,
      },
    })
    let actions!: ReturnType<typeof useUndoCloseAction>

    function Harness(): React.JSX.Element {
      actions = useUndoCloseAction(state, writer.setState, refs, sessionActionsWithSpawn(spawn))
      return <div />
    }

    const mounted = render(<Harness />)
    await act(async () => {
      await actions.undoClose()
    })

    expect(spawn).toHaveBeenCalledWith('/projects/related-child', {
      kind: 'codex',
      resumeSessionId: 'provider-old',
      recoverTmuxName: undefined,
      builtInMcpOverrides: { orchestration: false },
      tldrIdentity: undefined,
    })
    mounted.unmount()
  })

  it('restores every agent of a closed project with its own domain metadata', async () => {
    const state = { ...makeState(), tabs: [], sessions: {} } as WorkspaceState
    const refs = makeRefs(state)
    const writer = stateWriter(state, refs)
    const spawn = vi.fn()
      .mockResolvedValueOnce('restored-grid')
      .mockResolvedValueOnce('restored-detached')
    refs.undoStackRef.current.push({
      type: 'tab',
      closedAt: Date.now(),
      tab: { id: 'closed-tab', title: 'closed' },
      tabIndex: 0,
      sessions: [
        {
          sessionId: 'old-grid',
          meta: {
            cwd: '/projects/grid',
            kind: 'codex',
            providerSessionId: 'provider-grid',
            builtInMcpDomains: ['workflows'],
            projectId: 'closed-tab',
            joinedAt: 0,
          },
        },
        {
          sessionId: 'old-detached',
          meta: {
            cwd: '/projects/detached',
            kind: 'claude',
            providerSessionId: 'provider-detached',
            builtInMcpDomains: ['workflows'],
            projectId: 'closed-tab',
            joinedAt: 10,
          },
        },
      ],
    })
    let actions!: ReturnType<typeof useUndoCloseAction>

    function Harness(): React.JSX.Element {
      actions = useUndoCloseAction(state, writer.setState, refs, sessionActionsWithSpawn(spawn))
      return <div />
    }

    const mounted = render(<Harness />)
    await act(async () => {
      await actions.undoClose()
    })

    expect(spawn).toHaveBeenNthCalledWith(1, '/projects/grid', {
      kind: 'codex',
      resumeSessionId: 'provider-grid',
      recoverTmuxName: undefined,
      builtInMcpOverrides: { workflows: true },
      tldrIdentity: undefined,
    })
    expect(spawn).toHaveBeenNthCalledWith(2, '/projects/detached', {
      kind: 'claude',
      resumeSessionId: 'provider-detached',
      recoverTmuxName: undefined,
      builtInMcpOverrides: { workflows: true },
      tldrIdentity: undefined,
    })
    mounted.unmount()
  })
})
