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

const at = (text: string, revision: number, minutesAgo: number): TldrHistoryEntry => ({ text, revision, writtenAt: new Date(Date.now() - minutesAgo * 60_000).toISOString() })

function historyApi(entries: TldrHistoryEntry[], goals: TldrHistoryEntry[] = []) {
  const tldrListeners = new Set<(update: TldrUpdate) => void>()
  const goalListeners = new Set<(update: TldrUpdate) => void>()
  const subscribe = (listeners: Set<(update: TldrUpdate) => void>) => (listener: (update: TldrUpdate) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const fire = (listeners: Set<(update: TldrUpdate) => void>, identity: string) => { for (const listener of listeners) listener({ identity, record: { text: 'x', revision: 9, updatedAt: new Date().toISOString() } }) }
  const readTldrHistory = vi.fn(async () => entries)
  const readGoalHistory = vi.fn(async () => goals)
  window.api = { ...originalApi, readTldrHistory, readGoalHistory, onTldrChanged: subscribe(tldrListeners), onGoalChanged: subscribe(goalListeners) }
  return {
    readTldrHistory, readGoalHistory,
    emit: (identity: string) => fire(tldrListeners, identity),
    emitGoal: (identity: string) => fire(goalListeners, identity),
  }
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

  it('interleaves goal changes with status by time and marks the current one of each kind', async () => {
    const api = historyApi(
      [at('Tests pass; opening the PR.', 2, 1), at('Reading the store.', 1, 10)],
      [at('Let users see what each agent is for.', 2, 5), at('Add a history view.', 1, 20)],
    )
    render(<TldrHistoryModal open sessionId="pane" onClose={vi.fn()} workspace={workspaceWith({
      pane: { cwd: '/project', kind: 'claude', tldrIdentity: 'summary-1', builtInMcpDomains: ['tldr', 'goal'] },
    })} />)
    const list = await screen.findByRole('list', { name: 'TLDR history' })
    expect(api.readGoalHistory).toHaveBeenCalledWith('summary-1')
    const rows = [...list.querySelectorAll('li')].map(item => ({ text: item.querySelector('p')!.textContent, meta: item.querySelector('span')!.textContent! }))
    expect(rows.map(row => row.text)).toEqual([
      'Tests pass; opening the PR.', 'Let users see what each agent is for.', 'Reading the store.', 'Add a history view.',
    ])
    expect(rows[0]!.meta).toMatch(/^Current · /)
    // The newest goal is still the current goal although a status came after it.
    expect(rows[1]!.meta).toMatch(/^Goal · Current · /)
    expect(rows[2]!.meta).not.toContain('Current')
    expect(rows[3]!.meta).toMatch(/^Goal · /)
    expect(rows[3]!.meta).not.toContain('Current')

    // Revisions repeat across the two stores; both rows with revision 2 render.
    expect(list.querySelectorAll('li')).toHaveLength(4)
    act(() => api.emitGoal('someone-else'))
    expect(api.readGoalHistory).toHaveBeenCalledTimes(1)
    act(() => api.emitGoal('summary-1'))
    await waitFor(() => expect(api.readGoalHistory).toHaveBeenCalledTimes(2))
  })

  it('explains an agent that never had TLDR or Goal instead of reading someone else’s history', () => {
    const api = historyApi([])
    render(<TldrHistoryModal open sessionId="pane" onClose={vi.fn()} workspace={workspaceWith({ pane: { cwd: '/project', kind: 'claude' } })} />)
    expect(screen.getByText('TLDR and Goal have never been enabled for this agent.')).toBeTruthy()
    expect(api.readTldrHistory).not.toHaveBeenCalled()
    expect(api.readGoalHistory).not.toHaveBeenCalled()
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
  const completed = { ...emptyRuntime(), phaseChangedAt: Date.now(), streamPhase: 'idle' as const }

  it('says reporting enforcement is inactive after a turn produced no hook contact', async () => {
    peekApi(null)
    render(<TldrPane identity="agent" enabled provider="codex" runtime={completed}><div /></TldrPane>)
    act(toggleTldr)
    expect(await screen.findByText('Reporting check inactive')).toBeTruthy()
  })

  it('re-reads status as a turn progresses instead of keeping a warning read too early', async () => {
    let contact: string | null = null
    const readTldrEnforcement = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map(id => [id, { hookContactAt: contact }])))
    window.api = { ...originalApi, readTldrs: vi.fn(async () => ({})), onTldrChanged: () => () => {}, readTldrEnforcement }
    // The peek is latched open while a turn starts, before its first hook lands.
    const running = { ...emptyRuntime(), phaseChangedAt: 1_000, streamPhase: 'responding' as const }
    const view = render(<TldrPane identity="agent" enabled provider="codex" runtime={running}><div /></TldrPane>)
    act(toggleTldr)
    await waitFor(() => expect(readTldrEnforcement).toHaveBeenCalledTimes(1))
    expect(screen.queryByText('Reporting check inactive')).toBeNull()
    // The hook arrives and the turn ends while the peek stays open.
    contact = new Date().toISOString()
    view.rerender(<TldrPane identity="agent" enabled provider="codex" runtime={{ ...running, phaseChangedAt: 2_000, streamPhase: 'idle' }}><div /></TldrPane>)
    await waitFor(() => expect(readTldrEnforcement).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('Reporting check inactive')).toBeNull()
  })

  it('stays quiet when hooks made contact, before any turn, and for providers without hooks', async () => {
    peekApi(new Date().toISOString())
    const view = render(<TldrPane identity="agent" enabled provider="claude" runtime={completed}><div /></TldrPane>)
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
    view.rerender(<TldrPane identity="oc" enabled provider="opencode" runtime={completed}><div /></TldrPane>)
    await screen.findByText('No TLDR yet')
    expect(opencode).not.toHaveBeenCalled()
    expect(screen.queryByText('Reporting check inactive')).toBeNull()
  })
})
