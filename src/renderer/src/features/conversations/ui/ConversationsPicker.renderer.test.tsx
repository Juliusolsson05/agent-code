import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'

import type { Conversation, ConversationListResponse } from '@shared/conversations/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { ConversationsPicker } from './ConversationsPicker'

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
function install(list = vi.fn(async () => response())) {
  Object.defineProperty(window, 'api', { configurable: true, value: { listConversations: list, loadInitialHistory: vi.fn(async () => ({ entries: [], hasMore: false })) } })
  return list
}
// The picker reads the commanded pane through commandTargetSessionId, which
// walks state.tabs / activeTabId / dispatchMode, so the mock carries them.
type WorkspaceMock = Workspace & { replaceSession: Mock; newTab: Mock }
function workspace(over: Record<string, unknown> = {}): WorkspaceMock {
  return {
    activeTab: { id: 't', focusedSessionId: 's' },
    state: { tabs: [{ id: 't', focusedSessionId: 's' }], activeTabId: 't', dispatchMode: false, sessions: { s: { cwd: '/fixture/repo', kind: 'claude' } } },
    replaceSession: vi.fn(async () => 's2'),
    newTab: vi.fn(async () => undefined),
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
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'ArrowDown' })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Enter' })
    await waitFor(() => expect(ws.replaceSession).toHaveBeenCalledWith('/fixture/repo/.worktrees/extension-platform', { resumeSessionId: '01a08ddd-6327-7482-bd79-d1ade559677c', kind: 'codex' }))
    expect(onClose).toHaveBeenCalled()
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

  it('opens a new tab when no pane can be replaced', async () => {
    install()
    const ws = workspace({ activeTab: null, state: { tabs: [{ id: 't', focusedSessionId: 's' }], activeTabId: 't', dispatchMode: false, sessions: { s: { cwd: '/fixture/repo', kind: 'claude' } } } })
    render(<ConversationsPicker open focusSearch={false} workspace={ws} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByText('Project context bootstrapping'))
    await waitFor(() => expect(ws.newTab).toHaveBeenCalledWith('/fixture/repo', 'ededdea8-06bf-4474-b945-b3a8f8ce0fe1', 'claude'))
  })
})
