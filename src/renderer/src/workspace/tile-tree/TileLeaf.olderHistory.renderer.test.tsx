import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/store'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { Workspace } from '@renderer/workspace/hook'
import type { OlderHistoryLoadResult } from '@renderer/workspace/hook/actions/history'
import { AgentTerminalOwnerVisibilityProvider } from '@renderer/workspace/terminal/AgentTerminalOwnership'
import { OLDER_HISTORY_FAILED, TileLeaf } from './TileLeaf'

// #1250 row 12: a failed older-history page cleared its spinner and said
// nothing, so the feed looked as if it had nothing older. TileLeaf is where
// the answer from the hook meets the pane, so the wire is probed here: Feed is
// replaced by a probe that hands back the REAL `onLoadOlderHistory` prop
// TileLeaf passes down (through the real AgentFeed), and calling it is exactly
// what a scroll to the top does.

let loadOlder: (() => Promise<void>) | undefined
vi.mock('@renderer/features/feed/ui/Feed', () => ({
  Feed: ({ onLoadOlderHistory }: { onLoadOlderHistory?: () => Promise<void> }) => {
    loadOlder = onLoadOlderHistory
    return <div data-testid="feed" />
  },
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
beforeEach(() => { loadOlder = undefined })
afterEach(() => { cleanup(); vi.useRealTimers(); useAppStore.setState(original, true) })

function mount(answers: OlderHistoryLoadResult[]) {
  const paneToasts: string[] = []
  const toastSessions: string[] = []
  const workspace = {
    state: { sessions: { agent: { kind: 'claude', cwd: '/trial' }, other: { kind: 'claude', cwd: '/trial' } } },
    acknowledgeSession: vi.fn(),
    setDraftInput: vi.fn(),
    loadOlderHistory: vi.fn(async () => answers.shift() ?? 'skipped'),
    showPaneToast: (sessionId: string, message: string) => { paneToasts.push(message); toastSessions.push(sessionId) },
  } as unknown as Workspace
  const leaf = (sessionId: string) => (
    <AgentTerminalOwnerVisibilityProvider visible>
      <TileLeaf sessionId={sessionId} runtime={{ ...emptyRuntime(), hasOlderHistory: true }} workspace={workspace} focused onFocusRequest={vi.fn()} />
    </AgentTerminalOwnerVisibilityProvider>
  )
  const view = render(leaf('agent'))
  // A prop TileLeaf never passed would make every assertion below vacuous.
  expect(loadOlder).toBeTypeOf('function')
  return { paneToasts, toastSessions, workspace, switchTo: (sessionId: string) => view.rerender(leaf(sessionId)) }
}

it('says a failed page in fixed words, once per burst of retries', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const { paneToasts, toastSessions } = mount(['failed', 'failed', 'failed', 'failed'])
  await act(async () => { await loadOlder!() })
  // The literal words (#1413 review c): comparing against the exported
  // constant would let a reworded or interpolated message pass. And on THIS
  // pane.
  expect(paneToasts).toEqual(["Couldn't load older messages. Scroll up again to retry."])
  expect(toastSessions).toEqual(['agent'])
  expect(OLDER_HISTORY_FAILED).toBe(paneToasts[0])
  // Every scroll tick near the top retries; a burst is one toast.
  await act(async () => { await loadOlder!() })
  expect(paneToasts).toHaveLength(1)
  // Still inside the window a second later (review c: a window shrunk to
  // 500 ms would toast here).
  vi.setSystemTime(Date.now() + 1_000)
  await act(async () => { await loadOlder!() })
  expect(paneToasts).toHaveLength(1)
  // After the coalescing window, a new failure is said again.
  vi.setSystemTime(Date.now() + 4_001)
  await act(async () => { await loadOlder!() })
  expect(paneToasts).toEqual([OLDER_HISTORY_FAILED, OLDER_HISTORY_FAILED])
})

it('says nothing for a page that loaded or a request that was skipped', async () => {
  const { paneToasts } = mount(['loaded', 'skipped'])
  await act(async () => { await loadOlder!() })
  await act(async () => { await loadOlder!() })
  expect(paneToasts).toEqual([])
})

// Steering q106: the dispatch layout re-renders the SAME leaf with another
// agent when a lane switches. Agent A's toast must not silence agent B's
// first failure; repeated failures of one agent still coalesce.
it('does not let one agent\'s toast silence another agent in the same leaf', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const { paneToasts, toastSessions, switchTo } = mount(['failed', 'failed', 'failed'])
  await act(async () => { await loadOlder!() })
  switchTo('other')
  await act(async () => { await loadOlder!() })
  expect(toastSessions).toEqual(['agent', 'other'])
  await act(async () => { await loadOlder!() })
  expect(paneToasts).toEqual([OLDER_HISTORY_FAILED, OLDER_HISTORY_FAILED])
})
