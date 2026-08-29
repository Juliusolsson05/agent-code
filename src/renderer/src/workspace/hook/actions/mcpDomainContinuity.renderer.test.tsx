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
import type { DispatchModeState, WorkspaceState } from '@renderer/workspace/types'

function makeState(dispatchMode: DispatchModeState | null): WorkspaceState {
  return {
    tabs: [{
      id: 'tab-parent',
      title: 'parent',
      root: { type: 'leaf', sessionId: 'parent' },
      focusedSessionId: 'parent',
    }],
    activeTabId: 'tab-parent',
    dispatchMode,
    sessions: {
      parent: { cwd: '/projects/parent', kind: 'codex' },
    },
    detachedSessions: {},
    buried: [],
    pinnedSessionIds: [],
  } as WorkspaceState
}

describe('built-in MCP continuity at session resurrection boundaries', () => {
  it('scopes a normal split clone to the selected source cwd, not its physical parent', async () => {
    const harness = mountPaneActions(makeState(null))

    await act(async () => {
      await harness.actions.splitFocused('vertical', 'codex', {
        resumeSessionId: 'provider-clone',
        builtInMcpDomains: ['workflows'],
        cwd: '/projects/related-child',
      })
    })

    // WHY this deliberately disagrees with the parent fixture cwd: related agents can render as
    // tabs inside a parent pane while running in another worktree. The spawn boundary is where an
    // incorrect fallback would become a valid-but-wrong project-scoped bearer credential.
    expect(harness.spawn).toHaveBeenCalledWith('/projects/related-child', {
      kind: 'codex',
      resumeSessionId: 'provider-clone',
      builtInMcpDomains: ['workflows'],
    })
    harness.mounted.unmount()
  })

  it('keeps the explicit source cwd when Dispatch turns a split into a detached clone', async () => {
    const harness = mountPaneActions(makeState({
      scope: 'project',
      focusedSessionId: 'parent',
    }))

    await act(async () => {
      await harness.actions.splitFocused('vertical', 'codex', {
        resumeSessionId: 'provider-clone',
        builtInMcpDomains: ['workflows'],
        cwd: '/projects/related-child',
      })
    })

    expect(harness.spawn).toHaveBeenCalledWith('/projects/related-child', {
      kind: 'codex',
      resumeSessionId: 'provider-clone',
      builtInMcpDomains: ['workflows'],
    })
    harness.mounted.unmount()
  })

  it('restores a closed pane with fresh credentials derived from its captured domains', async () => {
    const state = makeState(null)
    const refs = makeRefs(state)
    const writer = stateWriter(state, refs)
    const spawn = vi.fn().mockResolvedValue('restored-pane')
    refs.undoStackRef.current.push({
      type: 'pane',
      closedAt: Date.now(),
      tabId: 'tab-parent',
      sessionMeta: {
        cwd: '/projects/related-child',
        kind: 'codex',
        providerSessionId: 'provider-old',
        builtInMcpDomains: ['workflows'],
      },
      direction: 'vertical',
      ratio: 0.5,
      side: 'a',
      siblingLeafId: 'parent',
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
      builtInMcpDomains: ['workflows'],
    })
    mounted.unmount()
  })

  it('restores an explicit all-off MCP selection instead of treating it as missing', async () => {
    const state = makeState(null)
    const refs = makeRefs(state)
    refs.defaultBuiltInMcpDomainsRef.current = ['orchestration']
    const writer = stateWriter(state, refs)
    const spawn = vi.fn().mockResolvedValue('restored-pane')
    refs.undoStackRef.current.push({
      type: 'pane',
      closedAt: Date.now(),
      tabId: 'tab-parent',
      sessionMeta: {
        cwd: '/projects/related-child',
        kind: 'codex',
        providerSessionId: 'provider-old',
        builtInMcpDomains: [],
      },
      direction: 'vertical',
      ratio: 0.5,
      side: 'a',
      siblingLeafId: 'parent',
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
      builtInMcpDomains: [],
    })
    mounted.unmount()
  })

  it('restores both grid and detached tab agents with their own domain metadata', async () => {
    const state = { ...makeState(null), tabs: [], sessions: {} } as WorkspaceState
    const refs = makeRefs(state)
    const writer = stateWriter(state, refs)
    const spawn = vi.fn()
      .mockResolvedValueOnce('restored-grid')
      .mockResolvedValueOnce('restored-detached')
    refs.undoStackRef.current.push({
      type: 'tab',
      closedAt: Date.now(),
      tab: {
        id: 'closed-tab',
        title: 'closed',
        root: { type: 'leaf', sessionId: 'old-grid' },
        focusedSessionId: 'old-grid',
      },
      tabIndex: 0,
      sessionMetas: {
        'old-grid': {
          cwd: '/projects/grid',
          kind: 'codex',
          providerSessionId: 'provider-grid',
          builtInMcpDomains: ['workflows'],
        },
      },
      detachedEntries: [{
        meta: {
          cwd: '/projects/detached',
          kind: 'claude',
          providerSessionId: 'provider-detached',
          builtInMcpDomains: ['workflows'],
        },
        detachedAt: 10,
      }],
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
      builtInMcpDomains: ['workflows'],
    })
    expect(spawn).toHaveBeenNthCalledWith(2, '/projects/detached', {
      kind: 'claude',
      resumeSessionId: 'provider-detached',
      recoverTmuxName: undefined,
      builtInMcpDomains: ['workflows'],
    })
    mounted.unmount()
  })
})
