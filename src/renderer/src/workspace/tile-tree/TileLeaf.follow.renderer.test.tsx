import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@renderer/app-state/store'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { Workspace } from '@renderer/workspace/hook'
import { AgentTerminalOwnerVisibilityProvider } from '@renderer/workspace/terminal/AgentTerminalOwnership'
import { TileLeaf } from './TileLeaf'

// Exercise the actual leaf, store subscriptions, metadata lookup and visibility
// context. Feed owns scrolling; this probe catches the missing wire
// that a policy-only test cannot (including passing raw tailMode by accident).
// Composer, transcript and workflow subsystems are outside that boundary.
vi.mock('@renderer/features/feed/ui/Feed', () => ({
  Feed: ({ tailMode }: { tailMode: boolean }) => <div data-testid="feed" data-follow={String(tailMode)} />,
}))
vi.mock('@renderer/features/sessionFeed/SessionFeedContext', () => ({ useSessionFeed: () => ({}) }))
vi.mock('@renderer/features/feed/ledger/useLedgerFeedItems', () => ({ useLedgerFeedItems: () => ({ items: [] }) }))
vi.mock('@renderer/features/usage-limit/useUsageLimitActions', () => ({ useUsageLimitActions: () => ({}) }))
vi.mock('@renderer/features/workflows/model/useSessionWorkflowViews', () => ({
  useSessionWorkflowViews: () => ({ references: [], allReferences: [], selectedReference: null }),
}))
vi.mock('./TileLeaf/useComposerKeybinds', () => ({ useComposerKeybinds: () => ({ onKeyDown: vi.fn(), slashMode: false, submitCurrentDraft: vi.fn() }) }))
vi.mock('./TileLeaf/useComposerDictation', () => ({ useComposerDictation: () => ({ handleShortcut: () => false }) }))
vi.mock('./TileLeaf/PaneHeader', () => ({ PaneHeader: () => null }))
vi.mock('./TileLeaf/QueueStrip', () => ({ QueueStrip: () => null }))
vi.mock('./TileLeaf/PaneToast', () => ({ PaneToast: () => null }))
vi.mock('./TileLeaf/ComposerInput', () => ({ ComposerInput: () => null }))
vi.mock('./TileLeaf/ComposerActions', () => ({ ComposerActions: () => null }))
vi.mock('@providers/shared/renderer/conditions/ProviderConditionOutlet', () => ({ ProviderConditionOutlet: () => null }))

const original = useAppStore.getState()
afterEach(() => { cleanup(); useAppStore.setState(original, true) })

it('wires working follow to the feed, releases human input and respects visibility and individual preferences', () => {
  useAppStore.setState({ tailAllMode: false, tailWorkingMode: false })
  const workspace = { state: { sessions: { agent: { kind: 'claude', cwd: '/trial' } } },
    acknowledgeSession: vi.fn(), setDraftInput: vi.fn(),
  } as unknown as Workspace
  const busy = { ...emptyRuntime(), sessionStatus: 'running' as const, streamPhase: 'awaiting-tool' as const }
  const blocked: SessionRuntime = { ...busy, conditions: { provider: 'claude', ts: 1,
    conditions: { 'claude.permission-prompt': { kind: 'claude.permission-prompt', state: { visible: true }, actions: [] } },
  } }
  const leaf = (runtime: SessionRuntime = busy, visible = true) => (
    <AgentTerminalOwnerVisibilityProvider visible={visible}>
      <TileLeaf sessionId="agent" runtime={runtime} workspace={workspace} focused={false} onFocusRequest={vi.fn()} />
    </AgentTerminalOwnerVisibilityProvider>
  )
  const view = render(leaf())
  const follows = () => screen.getByTestId('feed').getAttribute('data-follow')
  expect(follows()).toBe('false')
  act(() => useAppStore.getState().toggleTailWorkingMode())
  expect(follows()).toBe('true')
  view.rerender(leaf(blocked))
  expect(follows()).toBe('false')
  view.rerender(leaf())
  expect(follows()).toBe('true')
  view.rerender(leaf(busy, false))
  expect(follows()).toBe('false')
  view.rerender(leaf())
  expect(follows()).toBe('true')
  view.rerender(leaf(emptyRuntime()))
  expect(follows()).toBe('false')
  view.rerender(leaf({ ...blocked, tailMode: true }))
  expect(follows()).toBe('true')
  workspace.state.sessions.agent.kind = 'terminal'
  view.rerender(leaf())
  expect(follows()).toBe('false')
})
