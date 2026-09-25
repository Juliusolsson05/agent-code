import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/store'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { ConditionRefusal, ConditionRefusalReporter } from '@shared/conditions-core/dispatch'
import type { ConditionPtyAction } from '@shared/conditions-core/contract'
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
// whether `makeOutletDispatch` calls the reporter at all; that is covered
// against the real dispatcher in
// src/providers/shared/renderer/conditions/dispatchRefusal.renderer.test.tsx.

let reporter: ConditionRefusalReporter | undefined
/** The pty arm TileLeaf passes as `onPtyAction`, which reaches
 *  `sendConditionKey`. Probed through the real prop (#1177 renamed it from
 *  `onSend`), and adapted back to a keystroke so the tests read as one. A probe
 *  that no longer matches the prop leaves `sendKey` undefined, and `mount`'s
 *  assertion fails loudly rather than letting every keystroke test pass
 *  vacuously. */
let sendKey: ((data: string) => Promise<void>) | undefined
vi.mock('@providers/shared/renderer/conditions/ProviderConditionOutlet', () => ({
  ProviderConditionOutlet: (props: {
    onConditionRefused?: ConditionRefusalReporter
    onPtyAction?: (action: ConditionPtyAction) => Promise<void>
  }) => {
    reporter = props.onConditionRefused
    const onPtyAction = props.onPtyAction
    sendKey = onPtyAction ? data => onPtyAction({ kind: 'pty', id: 'probe', label: 'probe', data }) : undefined
    return <div data-testid="outlet" />
  },
}))

vi.mock('@renderer/features/feed/ui/Feed', () => ({ Feed: () => <div data-testid="feed" /> }))
// `sendInput` is what main's refusal comes back through; the tests that care
// set `sendInputResult` before clicking.
let sendInputResult = true
vi.mock('@renderer/features/sessionFeed/SessionFeedContext', () => ({
  useSessionFeed: () => ({ sendInput: async () => sendInputResult }),
}))
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
  sendKey = undefined
  sendInputResult = true
  paneToasts.length = 0
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

/** Every message TileLeaf tried to put in the PANE toast. */
const paneToasts: Array<{ sessionId: string; message: string }> = []

function mount(options?: { conditions?: SessionRuntime['conditions'] }): void {
  const workspace = {
    state: { sessions: { agent: { kind: 'claude', cwd: '/trial' } } },
    acknowledgeSession: vi.fn(),
    setDraftInput: vi.fn(),
    showPaneToast: (sessionId: string, message: string) => { paneToasts.push({ sessionId, message }) },
  } as unknown as Workspace
  const runtime: SessionRuntime = {
    ...emptyRuntime(),
    conditions: options?.conditions !== undefined ? options.conditions : {
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
  // A reporter or send TileLeaf never passed would make every assertion below
  // vacuous.
  expect(reporter).toBeTypeOf('function')
  expect(sendKey).toBeTypeOf('function')
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

// ---------------------------------------------------------------------------
// The pty arm (#711 item 1)
//
// #1070 moved the STRUCTURED refusal to the global toast because every
// condition that can refuse is a modal, and the pane toast is an in-flow
// sibling with no z-index sitting under a 1100-z scrim. The keystroke arm was
// left behind, so the same click produced a readable message or an invisible
// one depending on which arm handled it — and the keystroke arm is the one a
// TRUST DIALOG uses, i.e. the case where the modal is guaranteed to be up.
// ---------------------------------------------------------------------------

it('shows a refused keystroke where a modal cannot cover it', async () => {
  mount()
  sendInputResult = false

  await act(async () => { await sendKey?.('1') })

  const toast = screen.getByText(
    'That keystroke did not reach the agent. If it stays stuck, retry the pane.',
  )
  expect(toast.closest('[class*="z-[1200]"]')).not.toBeNull()
  // The pane toast is the surface this message used to go to, and it is under
  // the scrim. Asserting the text moved is not enough — a message sent to BOTH
  // would still pass that.
  expect(paneToasts).toEqual([])
})

it('says a vanished prompt is gone on the same surface as every other refusal', async () => {
  // The other early return of the same click. A single click must not land on
  // two different surfaces depending on which check failed first.
  mount({ conditions: null })

  await act(async () => { await sendKey?.('1') })

  expect(screen.getByText('That prompt is no longer live.')).toBeInTheDocument()
  expect(paneToasts).toEqual([])
})

it('holds a refused keystroke as long as the refusal it matches', async () => {
  // The comment beside the fix calls the duration load-bearing — 2.5s is not
  // enough to look at a trust dialog and decide. A mutation that drops both
  // duration arguments passed all 1013 renderer tests (#1110 review), because
  // the sibling reporter's duration test was never carried across to this arm.
  vi.useFakeTimers()
  mount()
  sendInputResult = false

  await act(async () => { await sendKey?.('1') })
  const message = 'That keystroke did not reach the agent. If it stays stuck, retry the pane.'
  expect(screen.getByText(message)).toBeInTheDocument()

  act(() => { vi.advanceTimersByTime(4_000) })
  expect(screen.getByText(message)).toBeInTheDocument()

  act(() => { vi.advanceTimersByTime(2_100) })
  expect(screen.queryByText(message)).toBeNull()
})

it('stays silent when the keystroke landed', async () => {
  mount()

  await act(async () => { await sendKey?.('1') })

  expect(screen.queryByText(/did not reach the agent/)).toBeNull()
  expect(paneToasts).toEqual([])
})
