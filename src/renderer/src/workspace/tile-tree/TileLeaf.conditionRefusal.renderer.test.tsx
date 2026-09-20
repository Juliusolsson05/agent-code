import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/store'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { ConditionRefusal, ConditionRefusalReporter } from '@shared/conditions-core/dispatch'
import type { Workspace } from '@renderer/workspace/hook'
import { GlobalToastProvider } from '@renderer/ui/GlobalToast'
import { AgentTerminalOwnerVisibilityProvider } from '@renderer/workspace/terminal/AgentTerminalOwnership'
import { TileLeaf } from './TileLeaf'

// #1070/#1099: the app half of "a refused custom action must say why".
//
// WHY this is a second TileLeaf file rather than a case in
// TileLeaf.follow.renderer.test.tsx: that file MOCKS ProviderConditionOutlet
// away to `() => null`, which is right for what it probes (feed follow) and
// fatal for this one — the mock never receives, let alone calls, the reporter
// TileLeaf passes down. That is exactly how the refusal wiring reached review
// with no test at all.
//
// The outlet is still mocked here, but as a PROBE rather than a hole: it
// renders a button that invokes the real `onConditionRefused` prop with a real
// refusal. Everything after that point — the describer, the toast surface, the
// duration — is the app's own, unmocked. The one thing this cannot see is
// whether `makeDispatchFromOnSend` calls the reporter at all; that is covered
// against the real dispatcher in
// src/providers/shared/renderer/conditions/dispatchRefusal.renderer.test.tsx.

let reporter: ConditionRefusalReporter | undefined
vi.mock('@providers/shared/renderer/conditions/ProviderConditionOutlet', () => ({
  ProviderConditionOutlet: (props: { onConditionRefused?: ConditionRefusalReporter }) => {
    reporter = props.onConditionRefused
    return <div data-testid="outlet" />
  },
}))

vi.mock('@renderer/features/feed/ui/Feed', () => ({ Feed: () => <div data-testid="feed" /> }))
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
vi.mock('./TileLeaf/ComposerInput', () => ({ ComposerInput: () => null }))
vi.mock('./TileLeaf/ComposerActions', () => ({ ComposerActions: () => null }))

const original = useAppStore.getState()
const originalApi = window.api

beforeEach(() => {
  reporter = undefined
  window.api = {
    ...(originalApi ?? {}),
    onExtensionNotification: vi.fn().mockReturnValue(() => {}),
  } as typeof window.api
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  useAppStore.setState(original, true)
  window.api = originalApi
})

const refusal = (over: Partial<ConditionRefusal> = {}): ConditionRefusal => ({
  action: { kind: 'custom', id: 'answer', label: 'Use TypeScript', name: 'claude.askUserQuestion.answer', payload: {} },
  reason: 'option-not-found',
  rawReason: 'option-not-found',
  failedAtStep: 'select-option',
  ...over,
})

function mount(): void {
  const workspace = {
    state: { sessions: { agent: { kind: 'claude', cwd: '/trial' } } },
    acknowledgeSession: vi.fn(),
    setDraftInput: vi.fn(),
  } as unknown as Workspace
  const runtime: SessionRuntime = {
    ...emptyRuntime(),
    conditions: {
      provider: 'claude',
      ts: 1,
      conditions: {
        'claude.ask-user-question': { kind: 'claude.ask-user-question', state: { visible: true }, actions: [] },
      },
    },
  }
  render(
    <GlobalToastProvider>
      <AgentTerminalOwnerVisibilityProvider visible>
        <TileLeaf sessionId="agent" runtime={runtime} workspace={workspace} focused onFocusRequest={vi.fn()} />
      </AgentTerminalOwnerVisibilityProvider>
    </GlobalToastProvider>,
  )
  // A reporter TileLeaf never passed would make every assertion below vacuous.
  expect(reporter).toBeTypeOf('function')
}

it('tells the user in words what the refusal was, on the surface a modal cannot cover', () => {
  mount()

  act(() => reporter?.(refusal()))

  const toast = screen.getByText(
    'That answer no longer matches what the agent is asking. Read the question again and answer it.',
  )
  // WHY the ancestor assertion and not just the text: the first cut of this
  // fix put the one message it produced into the PANE toast — an in-flow
  // sibling with no z-index, sitting under the 1100-z, 85%-opaque Radix scrim
  // and inside the subtree Radix marks aria-hidden. Every condition that can
  // refuse a custom action is a modal, and a refusal does not close it, so the
  // message was rendered exactly where nobody could read it. z-[1200] is the
  // whole point of GlobalToast and the only reason this is visible at all.
  expect(toast.closest('[class*="z-[1200]"]')).not.toBeNull()
  // The internal token is a console breadcrumb, not a user-facing message.
  expect(toast.textContent).not.toContain('option-not-found')
  expect(toast.textContent).not.toContain('select-option')
})

it('keeps a provider reason nobody has heard of readable instead of blank', () => {
  mount()

  // OpenCode Terminal and Grok emit reasons this union does not list; the
  // describer used to fall through its switch and return undefined, and a
  // toast with an empty message renders nothing — the silence the fix removes.
  act(() => reporter?.(refusal({ reason: 'unrecognised', rawReason: 'no-live-channel', failedAtStep: undefined })))

  expect(screen.getByText(
    'The agent refused that answer (no-live-channel). Read the question again and answer it.',
  )).toBeInTheDocument()
})

it('holds the message long enough to re-read the question it points at', () => {
  vi.useFakeTimers()
  mount()

  act(() => reporter?.(refusal()))
  const message = 'That answer no longer matches what the agent is asking. Read the question again and answer it.'
  expect(screen.getByText(message)).toBeInTheDocument()

  // GlobalToast's default is 2500ms. This message asks the reader to go back
  // to a multi-line question and answer it again; at the default it is gone
  // before that is possible, which is why the call passes 6000 explicitly.
  act(() => { vi.advanceTimersByTime(4000) })
  expect(screen.getByText(message)).toBeInTheDocument()

  act(() => { vi.advanceTimersByTime(2100) })
  expect(screen.queryByText(message)).toBeNull()
})

it('leaves the toast dismissable so it cannot sit over the question it is about', () => {
  mount()

  act(() => reporter?.(refusal()))
  const message = 'That answer no longer matches what the agent is asking. Read the question again and answer it.'
  fireEvent.click(screen.getByText(message))

  expect(screen.queryByText(message)).toBeNull()
})
