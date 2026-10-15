import { act, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/store'
import { AgentStatusPanelSurface } from '@renderer/features/agent-status/surfaces/AgentStatusPanelSurface'
import { GitBarSurface } from '@renderer/features/git/surfaces/GitBarSurface'
import { WorktreesBarSurface } from '@renderer/features/worktrees/surfaces/WorktreesBarSurface'

// #1517 review (critical): these side-panel surfaces stay MOUNTED while closed
// and return null. The lane-parity change added a store subscription
// (useCommandTargetInputs) AFTER `if (!open) return null`, so the first open
// rendered one more hook than the closed render and React threw "Rendered more
// hooks than during the previous render" — opening the Git bar crashed the
// window. The panels themselves are stand-ins; the hook order is the subject.

vi.mock('@renderer/workspace/WorkspaceContext', () => ({
  useWorkspaceContext: () => ({
    state: { sessions: { lane: { kind: 'claude', cwd: '/repo' } }, stage: { lanes: [{ selectedSessionId: 'lane' }], rows: [{ length: 1 }], focusedLane: 0 }, tabs: [], pinnedSessionIds: [] },
  }),
}))
vi.mock('@renderer/features/git/ui/GitBar', () => ({ GitBar: () => <div data-testid="panel" /> }))
vi.mock('@renderer/features/worktrees/ui/WorktreesBar', () => ({ WorktreesBar: () => <div data-testid="panel" /> }))
vi.mock('@renderer/features/agent-status/ui/AgentStatusPanel', () => ({ AgentStatusPanel: () => <div data-testid="panel" /> }))
vi.mock('@renderer/workspace/hook/selectors/commandTargetSessionId', async importOriginal => ({
  ...(await importOriginal<object>()),
  commandTargetSessionId: () => 'lane',
}))

const original = useAppStore.getState()
afterEach(() => { useAppStore.setState(original, true) })

describe('side panels open without changing their hook count', () => {
  it.each([
    ['Git bar', GitBarSurface, 'gitBarOpen'],
    ['Worktrees bar', WorktreesBarSurface, 'worktreesBarOpen'],
    ['Agent Status', AgentStatusPanelSurface, 'agentStatusPanelOpen'],
  ] as const)('%s', (_name, Surface, flag) => {
    useAppStore.setState({ [flag]: false } as never)
    const view = render(<Surface />)
    expect(view.queryByTestId('panel')).toBeNull()
    act(() => { useAppStore.setState({ [flag]: true } as never) })
    expect(view.getByTestId('panel')).toBeTruthy()
  })
})
