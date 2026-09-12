import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { TileTree, renderWorkspaceLeaf } from '@renderer/workspace/tile-tree/TileTree'
import { AgentTerminalOwnershipProvider } from '@renderer/workspace/terminal/AgentTerminalOwnership'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { dismissTldr, toggleTldr } from './viewState'

// Replace only the expensive provider/xterm leaf, retaining the real tree,
// related selection, surface selection, ownership boundary and TLDR overlay.
vi.mock('@providers/registry.renderer', () => ({ getRendererProvider: () => ({
  TileLeaf: ({ sessionId }: { sessionId: string }) => <div>Feed {sessionId}</div>,
}) }))
vi.mock('@renderer/workspace/tile-tree/AgentTerminalLeaf', () => ({ AgentTerminalLeaf: ({ sessionId }: { sessionId: string }) => <div>Agent terminal {sessionId}</div> }))
vi.mock('@renderer/workspace/tile-tree/TerminalLeaf', () => ({ TerminalLeaf: () => <div>Shell terminal</div> }))
const originalApi = window.api
afterEach(() => { cleanup(); dismissTldr(); window.api = originalApi })

describe('TLDR placement in the actual workspace leaf', () => {
  it.each(['agent', 'terminal'] as const)('uses the selected child’s identity and enablement in %s view', async mode => {
    const node = { type: 'split', direction: 'vertical', ratio: 0.5, a: { type: 'leaf', sessionId: 'parent' }, b: { type: 'leaf', sessionId: 'shell' } } as const
    const workspace = {
      state: {
        activeTabId: 'project', tabs: [{ id: 'project', title: 'Project', root: node, focusedSessionId: 'parent' }],
        sessions: {
          parent: { cwd: '/project', kind: 'claude', tldrIdentity: 'parent-summary', builtInMcpDomains: [] },
          child: { cwd: '/project/child', kind: 'codex', linkedParentId: 'parent', tldrIdentity: 'child-summary', builtInMcpDomains: ['tldr'] },
          shell: { cwd: '/project', kind: 'terminal' },
        },
        detachedSessions: { child: { sessionId: 'child', surface: 'dispatch', projectTabId: 'project', detachedAt: 1 } },
        gridRelatedSelections: { parent: 'child' }, buried: [], pinnedSessionIds: [],
      },
      getRuntime: (id: string) => ({ ...emptyRuntime(), lastJsonlEntryAt: Date.parse(id === 'child' ? '2026-09-10T01:00:00.000Z' : '2026-09-09T01:00:00.000Z') }),
    } as unknown as Workspace
    const readTldrs = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, { text: `Saved ${id}.`, revision: 1, updatedAt: '2026-09-11T00:00:00.000Z' }])))
    window.api = { ...originalApi, readTldrs, onTldrChanged: () => () => {} }
    const view = render(<AgentTerminalOwnershipProvider><TileTree tabId="project" node={node} focusedSessionId="parent" workspace={workspace} agentViewMode={mode} showStatusMode showWorktreeBadges /></AgentTerminalOwnershipProvider>)
    act(toggleTldr)
    await screen.findByText('Saved child-summary.')
    expect(screen.getAllByRole('note')).toHaveLength(1)
    expect(screen.queryByText('Saved parent-summary.')).toBeNull()
    expect(readTldrs).toHaveBeenCalledWith(['child-summary'])
    expect(screen.getByLabelText(/^Last active /).getAttribute('datetime')).toBe('2026-09-10T01:00:00.000Z')
    expect(screen.getByText(mode === 'agent' ? 'Feed child' : 'Agent terminal child')).toBeTruthy()
    expect(screen.getByText('Shell terminal')).toBeTruthy()

    // Dispatch and Spotlight call this shared entry directly. They must use
    // their explicit session, without following a grid parent's selection.
    view.rerender(<AgentTerminalOwnershipProvider>{renderWorkspaceLeaf('parent', 'parent', workspace, 'project', mode, true, true)}</AgentTerminalOwnershipProvider>)
    expect(screen.getByText('TLDR is off')).toBeTruthy()
    expect(screen.getByLabelText(/^Last active /).getAttribute('datetime')).toBe('2026-09-09T01:00:00.000Z')
    expect(screen.queryByText('Saved child-summary.')).toBeNull()
  })
})
