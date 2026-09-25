import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyRuntime } from '@renderer/session-runtime/state'
import { renderWorkspaceLeaf } from '@renderer/workspace/tile-tree/TileTree'
import { AgentTerminalOwnershipProvider } from '@renderer/workspace/terminal/AgentTerminalOwnership'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { dismissTldr, toggleTldr } from './viewState'

// Replace only the expensive provider/xterm leaf, retaining the real tree,
// related selection, surface selection, ownership boundary and TLDR overlay.
vi.mock('@renderer/workspace/tile-tree/TileLeaf', () => ({
  TileLeaf: ({ sessionId }: { sessionId: string }) => <div>Feed {sessionId}</div>,
}))
vi.mock('@renderer/workspace/tile-tree/AgentTerminalLeaf', () => ({ AgentTerminalLeaf: ({ sessionId }: { sessionId: string }) => <div>Agent terminal {sessionId}</div> }))
vi.mock('@renderer/workspace/tile-tree/TerminalLeaf', () => ({ TerminalLeaf: () => <div>Shell terminal</div> }))
const originalApi = window.api
afterEach(() => { cleanup(); dismissTldr(); window.api = originalApi })

describe('TLDR placement in the actual workspace leaf', () => {
  it.each(['agent', 'terminal'] as const)('uses the rendered session’s own identity and enablement in %s view', async mode => {
    const workspace = {
      state: {
        activeTabId: 'project', tabs: [{ id: 'project', title: 'Project' }],
        sessions: {
          parent: { cwd: '/project', kind: 'claude', tldrIdentity: 'parent-summary', builtInMcpDomains: [], projectId: 'project', joinedAt: 0 },
          child: { cwd: '/project/child', kind: 'codex', linkedParentId: 'parent', tldrIdentity: 'child-summary', builtInMcpDomains: ['tldr'], projectId: 'project', joinedAt: 1 },
          shell: { cwd: '/project', kind: 'terminal', projectId: 'project', joinedAt: 2 },
        },
        pinnedSessionIds: [],
      },
      getRuntime: (id: string) => ({ ...emptyRuntime(), lastJsonlEntryAt: Date.parse(id === 'child' ? '2026-09-10T01:00:00.000Z' : '2026-09-09T01:00:00.000Z') }),
    } as unknown as Workspace
    const readTldrs = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, { text: `Saved ${id}.`, revision: 1, updatedAt: '2026-09-11T00:00:00.000Z' }])))
    window.api = { ...originalApi, readTldrs, onTldrChanged: () => () => {} }
    // A lane shows the session it is asked to show — here the linked child,
    // selected into a lane beside a shell — and the TLDR pane must take ITS
    // identity and enablement, never its parent's.
    //
    // Until #992 this rendered the PARENT with related-agent tabs on and a
    // stored selection pointing at the child, so the leaf swapped the child
    // into the parent's tile. That swap is gone (see TileTree.tsx); the wiring
    // it exercised — leaf -> TldrPane(identity, enabled) — is the same.
    const view = render(<AgentTerminalOwnershipProvider>
      {renderWorkspaceLeaf('child', 'child', workspace, 'project', mode, true, true)}
      {renderWorkspaceLeaf('shell', 'child', workspace, 'project', mode, true, true)}
    </AgentTerminalOwnershipProvider>)
    act(toggleTldr)
    await screen.findByText('Saved child-summary.')
    expect(screen.getAllByRole('note')).toHaveLength(1)
    expect(screen.queryByText('Saved parent-summary.')).toBeNull()
    expect(readTldrs).toHaveBeenCalledWith(['child-summary'])
    expect(screen.getByLabelText(/^Last active /).getAttribute('datetime')).toBe('2026-09-10T01:00:00.000Z')
    expect(screen.getByText(mode === 'agent' ? 'Feed child' : 'Agent terminal child')).toBeTruthy()
    expect(screen.getByText('Shell terminal')).toBeTruthy()

    // The parent, rendered as itself, shows its own (disabled) TLDR state.
    view.rerender(<AgentTerminalOwnershipProvider>{renderWorkspaceLeaf('parent', 'parent', workspace, 'project', mode, true, true)}</AgentTerminalOwnershipProvider>)
    expect(screen.getByText('TLDR is off')).toBeTruthy()
    expect(screen.getByLabelText(/^Last active /).getAttribute('datetime')).toBe('2026-09-09T01:00:00.000Z')
    expect(screen.queryByText('Saved child-summary.')).toBeNull()
  })
})
