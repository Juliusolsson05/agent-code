import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { Conversation, ConversationListResponse } from '@shared/conversations/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { ConversationsPicker } from './ConversationsPicker'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
afterEach(() => {
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

// Rows shaped exactly like the catalog emits them for the corpus: an
// ai-titled Claude session on main, a Codex session on a worktree with a
// first-prompt label, and a fallback-labelled row. Ids from the corpus.
function row(over: Partial<Conversation>): Conversation {
  return {
    provider: 'claude', nativeId: 'ededdea8-06bf-4474-b945-b3a8f8ce0fe1', cwd: '/fixture/repo', repoRoot: '/fixture/repo', worktree: null,
    gitBranch: 'main', kind: 'user', parentNativeId: null, label: 'Project context bootstrapping', labelSource: 'ai-title', firstPrompt: 'Please read',
    agentName: 'Apollo', agentCodeTitle: null, createdAt: 1, lastUserActivityAt: Date.now() - 3 * 3600_000, activitySource: 'history',
    promptCount: 12, available: true, origin: 'scan', match: null, ...over,
  }
}
const rows = [
  row({}),
  row({ provider: 'codex', nativeId: '01a08ddd-6327-7482-bd79-d1ade559677c', cwd: '/fixture/repo/.worktrees/extension-platform', worktree: 'extension-platform', label: 'break down this project', labelSource: 'first-prompt', agentName: null, promptCount: null }),
  row({ provider: 'codex', nativeId: '6861f23d-0000-4000-8000-000000000000', label: 'repo', labelSource: 'cwd', firstPrompt: null, agentName: null, promptCount: 3 }),
]
function response(over: Partial<ConversationListResponse> = {}): ConversationListResponse {
  return { rows, total: 5, hiddenChildren: 2, nextCursor: null, family: { repoRoot: '/fixture/repo', roots: ['/fixture/repo'] }, timing: { ms: 3 }, ...over }
}
function install(list: Mock = vi.fn(async () => response())) {
  Object.defineProperty(window, 'api', { configurable: true, value: { listConversations: list, loadInitialHistory: vi.fn(async () => ({ entries: [], hasMore: false })) } })
  return list
}
// The picker reads the commanded pane through commandTargetSessionId, which
// walks state.tabs / activeTabId / dispatchMode, so the mock carries them.
type WorkspaceMock = Workspace & { replaceSession: Mock; newTab: Mock; showPaneToast: Mock }
function workspace(over: Record<string, unknown> = {}): WorkspaceMock {
  return {
    activeTab: { id: 't', focusedSessionId: 's' },
    state: { tabs: [{ id: 't', title: 'fixture' }], activeTabId: 't', stage: oneLaneStage('s'),   pinnedSessionIds: [], sessions: { s: { cwd: '/fixture/repo', kind: 'claude', projectId: 't', joinedAt: 0 } } },
    replaceSession: vi.fn(async () => 's2'),
    newTab: vi.fn(async () => undefined),
    showPaneToast: vi.fn(),
    ...over,
  } as unknown as WorkspaceMock
}

describe('ConversationsPicker', () => {
  it('lists rows with label, name, worktree, relative time, prompt count and a hidden-children toggle', async () => {
    const list = install()
    render(<ConversationsPicker open focusSearch={false} workspace={workspace()} onClose={vi.fn()} />)
    expect(await screen.findByText('Project context bootstrapping')).toBeInTheDocument()
    expect(screen.getByText('Apollo')).toBeInTheDocument()
    expect(screen.getByText('extension-platform')).toBeInTheDocument()
    expect(screen.getAllByText('3h ago').length).toBeGreaterThan(0)
    expect(screen.getByText('12 prompts')).toBeInTheDocument()
    expect(screen.getByText('repo')).toHaveClass('italic')
    expect(screen.getByRole('button', { name: /2 hidden/i })).toBeInTheDocument()
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/fixture/repo', scope: 'repository', includeChildren: false }))
  })

  it('resumes the highlighted row under its own cwd and provider on Enter', async () => {
    install()
    const ws = workspace()
    const onClose = vi.fn()
    render(<ConversationsPicker open focusSearch={false} workspace={ws} onClose={onClose} />)
    await screen.findByText('break down this project')
    // findByText resolves when the rows PAINT. When this was written the
    // picker reset the highlight in a passive effect that could still be
    // pending; in CI (run for #1266, 0c962aaa) it flushed after the ArrowDown
    // below, so Enter resumed row 0. Since #1297 the reset runs during render,
    // so the flush is belt-and-braces; confirming the arrow landed before
    // Enter is what makes the assertion honest. (No timeout was widened.)
    await act(async () => {})
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowDown' })
    await waitFor(() => expect(document.querySelector('[data-conversation-index="1"]')).toHaveAttribute('aria-selected', 'true'))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    // `newConversation` is part of this call's meaning, not a detail (#1090):
    // the picker swaps a STRANGER's conversation into the pane, so the
    // successor must not inherit the pane's orchestration parentage. Every
    // other caller of replaceSession continues the same agent and omits it.
    await waitFor(() => expect(ws.replaceSession).toHaveBeenCalledWith('/fixture/repo/.worktrees/extension-platform', { resumeSessionId: '01a08ddd-6327-7482-bd79-d1ade559677c', kind: 'codex', newConversation: true }))
    expect(onClose).toHaveBeenCalled()
    // A successful swap says nothing (#1262 review A).
    expect(ws.showPaneToast).not.toHaveBeenCalled()
  })

  // #1241: the picker closes, then swaps the pane. A failed swap used to be an
  // unhandled rejection (only journaled) or a silent `undefined`; the user saw
  // nothing change. The reason now lands on the pane it was meant for.
  const recordedSpawnFailure = (JSON.parse(readFileSync(join(import.meta.dirname,
    '../../../../../../testing/fixtures/spawn-failure/posix-spawnp-2026-09-23.json'), 'utf8')) as { reason: string }).reason

  it('tells the pane why an in-place resume failed to start (#1241)', async () => {
    install()
    const ws = workspace({ replaceSession: vi.fn(async () => { throw new Error(recordedSpawnFailure) }) })
    render(<ConversationsPicker open focusSearch={false} workspace={ws} onClose={vi.fn()} />)
    await screen.findByText('break down this project')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    await waitFor(() => expect(ws.showPaneToast).toHaveBeenCalledWith('s', "Couldn't resume Project context bootstrapping: Session failed to start. Check provider setup and retry."))
    // Never the raw IPC rejection: it can carry environment values or tokens.
    expect(JSON.stringify(ws.showPaneToast.mock.calls)).not.toContain('posix_spawnp')
    expect(JSON.stringify(ws.showPaneToast.mock.calls)).not.toContain('Error invoking remote method')
  })

  it('tells the pane when an in-place resume could not happen at all (#1241)', async () => {
    install()
    const ws = workspace({ replaceSession: vi.fn(async () => undefined) })
    render(<ConversationsPicker open focusSearch={false} workspace={ws} onClose={vi.fn()} />)
    await screen.findByText('break down this project')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    await waitFor(() => expect(ws.showPaneToast).toHaveBeenCalledWith('s', "Couldn't resume Project context bootstrapping in this pane."))
  })

  it('does not leave an unhandled rejection when a new-tab resume fails (#1262 review A)', async () => {
    install()
    const ws = workspace({ activeTab: null, newTab: vi.fn(async () => { throw new Error('newTab already toasted this') }) })
    render(<ConversationsPicker open focusSearch={false} workspace={ws} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'everywhere' }))
    await screen.findByText('break down this project')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    await waitFor(() => expect(ws.newTab).toHaveBeenCalled())
  })

  it('stays open and says why when no pane is selected to resume into (#1241)', async () => {
    install()
    const onClose = vi.fn()
    const base = workspace()
    const ws = workspace({ state: { ...base.state, stage: { lanes: [{}], rows: [{ length: 1 }], focusedLane: 0 } } })
    render(<ConversationsPicker open focusSearch={false} workspace={ws} onClose={onClose} />)
    // Without a pane only the everywhere scope lists rows.
    fireEvent.click(screen.getByRole('button', { name: 'everywhere' }))
    await screen.findByText('break down this project')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    expect(await screen.findByText(/no agent pane is selected/)).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    // Moving the highlight clears the error that named the previous row.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowDown' })
    await waitFor(() => expect(screen.queryByText(/no agent pane is selected/)).not.toBeInTheDocument())
    expect(ws.replaceSession).not.toHaveBeenCalled()
  })

  it('does not resume the highlighted row when Enter presses a filter chip (#867)', async () => {
    // The picker handles Enter on `DialogContent` and `preventDefault`s it, so
    // the chips inside that content — ordinary tabbable buttons — never got
    // their native click. Tab to "everywhere" and press Enter and the chip did
    // not toggle: the picker RESUMED the highlighted conversation instead,
    // replacing what was running in the focused pane. The #867 audit called
    // this consumer safe for having no footer; the rule is about the focused
    // CONTROL, not the footer slot.
    install()
    const ws = workspace()
    render(<ConversationsPicker open focusSearch={false} workspace={ws} onClose={vi.fn()} />)
    await screen.findByText('break down this project')
    const chip = screen.getByRole('button', { name: 'everywhere' })

    // `true` = the default survived, which is what lets a real browser deliver
    // the chip's own click.
    expect(fireEvent.keyDown(chip, { key: 'Enter' })).toBe(true)

    expect(ws.replaceSession).not.toHaveBeenCalled()
    expect(chip.getAttribute('aria-pressed')).toBe('false')
  })

  it('re-queries with the toggled scope, provider and children filters, and with the typed query', async () => {
    const list = install()
    render(<ConversationsPicker open focusSearch workspace={workspace()} onClose={vi.fn()} />)
    await screen.findByText('Project context bootstrapping')
    fireEvent.click(screen.getByRole('button', { name: /2 hidden/i }))
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ includeChildren: true })))
    fireEvent.click(screen.getByRole('button', { name: /^everywhere$/i }))
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'everywhere' })))
    fireEvent.click(screen.getByRole('button', { name: /^codex$/i }))
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ providers: ['codex'] })))
    const input = screen.getByPlaceholderText(/search conversations/i)
    await waitFor(() => expect(document.activeElement).toBe(input))
    fireEvent.change(input, { target: { value: 'break down' } })
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'break down' })))
  })

  it('distinguishes a listing failure from an empty result', async () => {
    install(vi.fn(async () => { throw new Error('sqlite locked') }))
    const first = render(<ConversationsPicker open focusSearch={false} workspace={workspace()} onClose={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent(/couldn.t load conversations/i)
    first.unmount()
    install(vi.fn(async () => response({ rows: [], total: 0, hiddenChildren: 0 })))
    render(<ConversationsPicker open focusSearch={false} workspace={workspace()} onClose={vi.fn()} />)
    expect(await screen.findByText(/no conversations recorded/i)).toBeInTheDocument()
  })

  it('refuses to resume a row whose transcript file is gone and says why', async () => {
    install(vi.fn(async () => response({ rows: [row({ label: 'Gone thread', available: false })], total: 1, hiddenChildren: 0 })))
    const ws = workspace()
    render(<ConversationsPicker open focusSearch={false} workspace={ws} onClose={vi.fn()} />)
    const gone = await screen.findByText('Gone thread')
    expect(gone.closest('[role="option"]')).toHaveAttribute('aria-disabled', 'true')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    fireEvent.click(gone)
    expect(await screen.findByRole('alert')).toHaveTextContent(/transcript file is missing/i)
    expect(ws.replaceSession).not.toHaveBeenCalled()
    expect(ws.newTab).not.toHaveBeenCalled()
  })

  it('asks for a pane when none is commanded, and lists everywhere without one', async () => {
    const list = install()
    const ws = workspace({ state: { tabs: [{ id: 't', title: 'fixture' }], activeTabId: 't', stage: oneLaneStage('s'),   pinnedSessionIds: [], sessions: {} } })
    render(<ConversationsPicker open focusSearch={false} workspace={ws} onClose={vi.fn()} />)
    expect(await screen.findByText(/focus a pane to list its repository/i)).toBeInTheDocument()
    expect(list).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /^everywhere$/i }))
    await waitFor(() => expect(list).toHaveBeenCalledWith(expect.objectContaining({ cwd: '', scope: 'everywhere' })))
    expect(await screen.findByText('Project context bootstrapping')).toBeInTheDocument()
  })

  it('opens a new tab when no pane can be replaced', async () => {
    install()
    const ws = workspace({ activeTab: null, state: { tabs: [{ id: 't', title: 'fixture' }], activeTabId: 't', stage: oneLaneStage('s'),   pinnedSessionIds: [], sessions: { s: { cwd: '/fixture/repo', kind: 'claude', projectId: 't', joinedAt: 0 } } } })
    render(<ConversationsPicker open focusSearch={false} workspace={ws} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByText('Project context bootstrapping'))
    await waitFor(() => expect(ws.newTab).toHaveBeenCalledWith('/fixture/repo', 'ededdea8-06bf-4474-b945-b3a8f8ce0fe1', 'claude'))
  })

  // Steering q27: an enablement refresh (the setup check finishing, a
  // provider toggled in another window) rebuilt the `providers` filter array
  // with identical contents, and the reset keyed on the array's identity threw
  // the user's highlight back to row 0, so Enter resumed a conversation the
  // user had not chosen.
  it('keeps the highlight when an enablement refresh leaves the filter unchanged', async () => {
    install()
    const ws = workspace()
    render(<ConversationsPicker open focusSearch={false} workspace={ws} onClose={vi.fn()} />)
    await screen.findByText('break down this project')
    await act(async () => {})
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowDown' })
    await waitFor(() => expect(document.querySelector('[data-conversation-index="1"]')).toHaveAttribute('aria-selected', 'true'))
    const { useProviderEnablementStore } = await import('@renderer/features/providers/store')
    await act(async () => { useProviderEnablementStore.setState({ enabledKinds: new Set(useProviderEnablementStore.getState().enabledKinds) }) })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    await waitFor(() => expect(ws.replaceSession).toHaveBeenCalledWith('/fixture/repo/.worktrees/extension-platform', expect.objectContaining({ kind: 'codex' })))
  })

  // #1297 review A: while a new scope or query loads, the rows on screen
  // answer the OLD parameters, and the keyboard must not act on them.
  function heldList() {
    const pending: Array<() => void> = []
    const list = install(vi.fn(async (request: { scope?: string; query?: string }) => {
      if (request.scope === 'everywhere' || request.query) {
        await new Promise<void>(resolve => { pending.push(resolve) })
        // The new page keeps row 0 but has a DIFFERENT row 1.
        return response({ rows: [rows[0]!, row({ provider: 'codex', nativeId: 'different-row-1', label: 'a different conversation', labelSource: 'first-prompt' })] })
      }
      return response()
    }))
    return { list, release: () => pending.splice(0).forEach(resolve => resolve()) }
  }

  it('does not resume a row from the old scope while the new scope loads', async () => {
    const { list, release } = heldList()
    const ws = workspace()
    render(<ConversationsPicker open focusSearch={false} workspace={ws} onClose={vi.fn()} />)
    await screen.findByText('break down this project')
    fireEvent.click(screen.getByRole('button', { name: 'everywhere' }))
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'everywhere' })))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    await act(async () => {})
    expect(ws.replaceSession).not.toHaveBeenCalled()
    release()
    await screen.findByText('a different conversation')
  })

  it('does not carry an arrow press on old rows over to the new page', async () => {
    const { list, release } = heldList()
    render(<ConversationsPicker open focusSearch={false} workspace={workspace()} onClose={vi.fn()} />)
    await screen.findByText('break down this project')
    fireEvent.click(screen.getByRole('button', { name: 'everywhere' }))
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'everywhere' })))
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowDown' })
    release()
    const different = await screen.findByText('a different conversation')
    expect(different.closest('[data-conversation-index]')).toHaveAttribute('aria-selected', 'false')
    expect(document.querySelector('[data-conversation-index="0"]')).toHaveAttribute('aria-selected', 'true')
  })

  // #1297 review B: pin that the reset still HAPPENS on a new query, and does
  // not happen when loadMore only appends.
  it('moves the highlight back to row 0 for a new query', async () => {
    const { list, release } = heldList()
    render(<ConversationsPicker open focusSearch={false} workspace={workspace()} onClose={vi.fn()} />)
    await screen.findByText('break down this project')
    await act(async () => {})
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowDown' })
    await waitFor(() => expect(document.querySelector('[data-conversation-index="1"]')).toHaveAttribute('aria-selected', 'true'))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'something' } })
    await waitFor(() => expect(document.querySelector('[data-conversation-index="0"]')).toHaveAttribute('aria-selected', 'true'))
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'something' })))
    release()
    await screen.findByText('a different conversation')
    expect(document.querySelector('[data-conversation-index="0"]')).toHaveAttribute('aria-selected', 'true')
  })

  // #1297 round 2: a loadMore across a filter change appended new-scope rows
  // to old-scope rows and marked the mix fresh, reopening Enter on them.
  it('does not page old rows after the scope changed', async () => {
    const list = install(vi.fn(async (request: { scope?: string; cursor?: string | null }) => {
      if (request.scope === 'everywhere' && !request.cursor) return new Promise<never>(() => {})
      return response({ nextCursor: 'next-page' })
    }))
    const ws = workspace()
    render(<ConversationsPicker open focusSearch={false} workspace={ws} onClose={vi.fn()} />)
    await screen.findByText('break down this project')
    fireEvent.click(screen.getByRole('button', { name: 'everywhere' }))
    // Scrolling the old list asks for more while the new scope loads.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowDown' })
    await act(async () => {})
    expect(list.mock.calls.some(([request]) => (request as { cursor?: string | null }).cursor === 'next-page')).toBe(false)
    expect(screen.getByText(/^loading…/)).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    await act(async () => {})
    expect(ws.replaceSession).not.toHaveBeenCalled()
  })
})

