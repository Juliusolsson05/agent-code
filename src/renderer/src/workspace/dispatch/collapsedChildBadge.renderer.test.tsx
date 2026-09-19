import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DispatchAgentList } from './DispatchAgentList'
import type { DispatchAgentRow } from './dispatchSelectors'
import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'

// #1013 review B: orchestration children always land in the pool wearing the
// "new" badge, and the child cap hides every child past the third. In a
// 5-worker run two badges were never visible, and the "+2 more" row said
// nothing. The list is rendered for real, with the row's own store selector.
const state = vi.hoisted(() => ({
  settings: { dispatchColorFlags: {} },
  workspaceRuntimes: {} as Record<string, SessionRuntime>,
}))
vi.mock('@renderer/app-state/hooks', () => ({
  useAppStore: (selector: (value: typeof state) => unknown) => selector(state),
}))
afterEach(() => { cleanup(); state.workspaceRuntimes = {} })

const row = (sessionId: string, depth: number, index: number): DispatchAgentRow => ({
  key: `project:${sessionId}`, label: `A${index}`, globalIndex: index,
  tabId: 'project', tabTitle: 'Project', tabIndex: 0, sessionId,
  kind: 'claude', title: sessionId, depth,
})
const rows = [row('root', 0, 1), ...[1, 2, 3, 4, 5].map(n => row(`worker-${n}`, 1, n + 1))]
const renderList = () => render(<DispatchAgentList
  groups={[{ tab: { id: 'project', title: 'Project' }, tabIndex: 0, rows }]}
  pinnedRows={[]}
  activeSessionId="root"
  focusSessionInTab={vi.fn()}
  showWorktreeBadges={false}
/>)

it('the "+N more" row wears the badge when a hidden child is new', () => {
  for (const id of ['root', 'worker-1', 'worker-2', 'worker-3', 'worker-4', 'worker-5']) state.workspaceRuntimes[id] = emptyRuntime()
  state.workspaceRuntimes['worker-5'] = { ...emptyRuntime(), pooledSpawnAt: 1 }
  renderList()
  const more = screen.getByText('+ 2 more').closest('button')!
  expect(more.querySelector('[data-dispatch-new-in-pool]')).not.toBeNull()
})

it('and does not when every hidden child has been placed', () => {
  for (const id of ['root', 'worker-1', 'worker-2', 'worker-3', 'worker-4', 'worker-5']) state.workspaceRuntimes[id] = emptyRuntime()
  // Only a VISIBLE child is new; its own row carries that badge.
  state.workspaceRuntimes['worker-1'] = { ...emptyRuntime(), pooledSpawnAt: 1 }
  renderList()
  const more = screen.getByText('+ 2 more').closest('button')!
  expect(more.querySelector('[data-dispatch-new-in-pool]')).toBeNull()
})
