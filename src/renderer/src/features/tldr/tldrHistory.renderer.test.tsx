import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TldrHistoryEntry, TldrUpdate } from '@shared/types/tldr'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { CommandContext } from '@renderer/features/command-palette/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { tldrCommands } from './commands'
import { TldrHistoryModal } from './TldrHistoryModal'
import { TldrPane } from './TldrOverlay'
import { dismissTldr, toggleTldr } from './viewState'

const originalApi = window.api
afterEach(() => { cleanup(); dismissTldr(); window.api = originalApi })

const entry = (text: string, revision: number): TldrHistoryEntry => ({ text, revision, writtenAt: new Date(Date.now() - revision * 60_000).toISOString() })
const workspaceWith = (sessions: Record<string, unknown>) => ({ state: { sessions } }) as unknown as Workspace

function historyApi(entries: TldrHistoryEntry[]) {
  const listeners = new Set<(update: TldrUpdate) => void>()
  const readTldrHistory = vi.fn(async () => entries)
  window.api = { ...originalApi, readTldrHistory, onTldrChanged: (listener: (update: TldrUpdate) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  return { readTldrHistory, emit: (identity: string) => { for (const listener of listeners) listener({ identity, record: { text: 'x', revision: 9, updatedAt: new Date().toISOString() } }) } }
}

describe('TLDR history', () => {
  it('shows the conversation’s own history newest first and refreshes only for its identity', async () => {
    const api = historyApi([entry('Complete. PR #1 is open.', 3), entry('Store done; building the modal.', 2), entry('Goal: add history.', 1)])
    render(<TldrHistoryModal open sessionId="pane" onClose={vi.fn()} workspace={workspaceWith({
      pane: { cwd: '/project', kind: 'codex', tldrIdentity: 'summary-1', builtInMcpDomains: ['tldr'] },
    })} />)
    const list = await screen.findByRole('list', { name: 'TLDR history' })
    expect(api.readTldrHistory).toHaveBeenCalledWith('summary-1')
    const items = list.querySelectorAll('li')
    expect([...items].map(item => item.querySelector('p')!.textContent)).toEqual([
      'Complete. PR #1 is open.', 'Store done; building the modal.', 'Goal: add history.',
    ])
    expect(items[0]!.textContent).toContain('Current')
    expect(items[1]!.textContent).not.toContain('Current')

    act(() => api.emit('someone-else'))
    expect(api.readTldrHistory).toHaveBeenCalledTimes(1)
    act(() => api.emit('summary-1'))
    await waitFor(() => expect(api.readTldrHistory).toHaveBeenCalledTimes(2))
  })

  it('explains an agent that never had TLDR instead of reading someone else’s history', () => {
    const api = historyApi([])
    render(<TldrHistoryModal open sessionId="pane" onClose={vi.fn()} workspace={workspaceWith({ pane: { cwd: '/project', kind: 'claude' } })} />)
    expect(screen.getByText('TLDR has never been enabled for this agent.')).toBeTruthy()
    expect(api.readTldrHistory).not.toHaveBeenCalled()
  })

  it('opens from the focused agent and is not offered for a shell', () => {
    const command = tldrCommands.find(candidate => candidate.id === 'view-tldr-history')!
    const ui = { closePalette: vi.fn(), openTldrHistory: vi.fn() }
    const workspace = (kind: string) => ({
      state: { activeTabId: 'tab', tabs: [{ id: 'tab', focusedSessionId: 'pane', root: { type: 'leaf', sessionId: 'pane' } }], sessions: { pane: { cwd: '/project', kind } }, dispatchMode: null, detachedSessions: {} },
    }) as unknown as Workspace
    expect(command.when?.({ workspace: workspace('terminal'), ui } as unknown as CommandContext)).toBe(false)
    const context = { workspace: workspace('codex'), ui } as unknown as CommandContext
    expect(command.when?.(context)).toBe(true)
    void command.run(context)
    expect(ui.closePalette).toHaveBeenCalledOnce()
    expect(ui.openTldrHistory).toHaveBeenCalledWith('pane')
  })
})

describe('TLDR enforcement status in the peek', () => {
  function peekApi(hookContactAt: string | null) {
    const readTldrEnforcement = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, { hookContactAt }])))
    window.api = {
      ...originalApi,
      readTldrs: vi.fn(async () => ({})),
      onTldrChanged: () => () => {},
      readTldrEnforcement,
    }
    return readTldrEnforcement
  }
  const submitted = { ...emptyRuntime(), submittedAt: Date.now() }

  it('says reporting enforcement is inactive after a turn produced no hook contact', async () => {
    peekApi(null)
    render(<TldrPane identity="agent" enabled provider="codex" runtime={submitted}><div /></TldrPane>)
    act(toggleTldr)
    expect(await screen.findByText('Reporting check inactive')).toBeTruthy()
  })

  it('stays quiet when hooks made contact, before any turn, and for providers without hooks', async () => {
    peekApi(new Date().toISOString())
    const view = render(<TldrPane identity="agent" enabled provider="claude" runtime={submitted}><div /></TldrPane>)
    act(toggleTldr)
    await screen.findByText('No TLDR yet')
    await waitFor(() => expect(window.api.readTldrEnforcement).toHaveBeenCalled())
    expect(screen.queryByText('Reporting check inactive')).toBeNull()

    // A freshly loaded agent has had no turn for its hooks to fire on.
    peekApi(null)
    view.rerender(<TldrPane identity="fresh" enabled provider="claude" runtime={emptyRuntime()}><div /></TldrPane>)
    await waitFor(() => expect(window.api.readTldrEnforcement).toHaveBeenCalledWith(['fresh']))
    expect(screen.queryByText('Reporting check inactive')).toBeNull()

    const opencode = peekApi(null)
    view.rerender(<TldrPane identity="oc" enabled provider="opencode" runtime={submitted}><div /></TldrPane>)
    await screen.findByText('No TLDR yet')
    expect(opencode).not.toHaveBeenCalled()
    expect(screen.queryByText('Reporting check inactive')).toBeNull()
  })
})
