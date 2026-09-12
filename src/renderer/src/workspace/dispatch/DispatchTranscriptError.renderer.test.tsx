import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DispatchAgentList } from './DispatchAgentList'
import type { DispatchAgentRow } from './dispatchSelectors'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'

const state = vi.hoisted(() => ({
  settings: { dispatchColorFlags: {} },
  workspaceRuntimes: {} as Record<string, SessionRuntime>,
}))
vi.mock('@renderer/app-state/hooks', () => ({
  // Keep the row's real selector: testing only dispatchSubtitle would miss a
  // component that never subscribes to transcriptError in the first place.
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state),
}))
afterEach(() => { cleanup(); state.workspaceRuntimes = {} })

it('renders the transcript diagnostic instead of a healthy activity subtitle', () => {
  const message = 'OpenCode switched to session ses_new inside the TUI. This pane still follows ses_old. Resume ses_new from the Resume picker to follow it. (provider_session_switched)'
  state.workspaceRuntimes.pane = { ...emptyRuntime(), sessionStatus: 'running', streamPhase: 'thinking', transcriptStatus: 'error', transcriptError: message }
  const row: DispatchAgentRow = {
    key: 'project:grid:pane', label: 'A1', globalIndex: 1,
    tabId: 'project', tabTitle: 'Project', tabIndex: 0, sessionId: 'pane',
    kind: 'opencode', title: 'Task', placement: 'grid', depth: 0,
  }
  render(<DispatchAgentList
    groups={[{ tab: { id: 'project', title: 'Project', root: { type: 'leaf', sessionId: 'pane' }, focusedSessionId: 'pane' }, tabIndex: 0, rows: [row] }]}
    pinnedRows={[]}
    activeSessionId="pane"
    dispatchScope="project"
    focusSessionInTab={vi.fn()}
    showWorktreeBadges={false}
  />)
  expect(screen.getByText(message)).toBeInTheDocument()
  expect(screen.queryByText('thinking')).not.toBeInTheDocument()
})
