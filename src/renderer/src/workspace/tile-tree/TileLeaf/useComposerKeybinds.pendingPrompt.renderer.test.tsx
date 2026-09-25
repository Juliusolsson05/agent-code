import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/hooks'
import { useLedgerFeedItems } from '@renderer/features/feed/ledger/useLedgerFeedItems'
import { Feed } from '@renderer/features/feed/ui/Feed'
import { SessionFeedProvider } from '@renderer/features/sessionFeed/SessionFeedContext'
import { createFakeSessionFeed } from '@renderer/features/sessionFeed/FakeSessionFeed'
import type { FakeSessionFeed } from '@renderer/features/sessionFeed/FakeSessionFeed'
import { optimisticPromptUuid } from '@renderer/session-runtime/optimisticPrompt'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { PromptDeliveryResult } from '@shared/types/providerConfig'
import type { AgentProviderKind } from '@shared/types/providerKind'
import { oneLaneStage } from '@renderer/workspace/testing/stageFixtures'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import { useWorkspace } from '@renderer/workspace/hook'
import { useSessionRuntime } from '@renderer/workspace/useSessionRuntime'

import { ComposerInput } from './ComposerInput'
import { useComposerKeybinds } from './useComposerKeybinds'

// #1181: Enter moves the prompt out of the composer and into the feed as a
// dimmed `Sending…` row, and the composer stays locked until the provider
// accepts or rejects it. Before this, the draft stayed editable in the
// composer for the whole JSONL acknowledgement (seconds for Claude), and
// Claude painted no user row at all until the transcript caught up.
//
// Same harness shape as useComposerKeybinds.queueAcceptance: the REAL workspace
// controller, the REAL submit hook, the REAL ledger → Feed path, and a fake
// feed whose delivery the test holds open. Holding the delivery open is the
// point: every contract here is about the window BETWEEN Enter and acceptance,
// which a feed that answers synchronously would make unobservable.

vi.mock('@renderer/workspace/hook/ipc/useIpcSubscriptions', () => ({ useIpcSubscriptions: () => undefined }))
vi.mock('@renderer/workspace/hook/ipc/useWorkspaceAdoption', () => ({ useWorkspaceAdoption: () => undefined }))
vi.mock('@renderer/workspace/hook/persistence/useBootstrap', async () => {
  const { useEffect } = await import('react')
  return { useBootstrap: (...args: Parameters<typeof import('@renderer/workspace/hook/persistence/useBootstrap').useBootstrap>) => {
    useEffect(() => args[4](true), [args[4]])
  } }
})

const SESSION = '8d1f6a8e-5c7f-4c55-9d52-2a3c0f0e1181' as SessionId
const original = useAppStore.getState()
const originalApi = window.api

let current!: ReturnType<typeof useWorkspace>
let submit!: (source: 'textarea-enter' | 'global-enter' | 'button') => Promise<void>
type SendFn = (data: string, pasteId?: string) => Promise<void>
let sendSpy: ReturnType<typeof vi.fn<SendFn>>

function Pane({ workspace, provider }: { workspace: ReturnType<typeof useWorkspace>; provider: AgentProviderKind }) {
  // Mirrors TileLeaf: `input` IS runtime.draftInput, the lock and the pending
  // row are both derived from `promptDelivery`, and Feed gets its items from
  // the production ledger hook.
  const runtime = useSessionRuntime(workspace, SESSION)
  const input = runtime.draftInput
  const setInputText = (next: string) => workspace.setDraftInput(SESSION, next)
  const keys = useComposerKeybinds({
    sessionId: SESSION,
    provider,
    runtime,
    workspace,
    input,
    setInputText,
    send: (...args) => sendSpy(...args),
    sendConditionKey: async () => {},
    history: [],
    historyIndex: null,
    historyAnchor: '',
    cyclingHistory: false,
    setHistoryIndex: () => {},
    setHistoryAnchor: () => {},
    endHistoryCycle: () => {},
  })
  submit = keys.submitCurrentDraft
  const plan = useLedgerFeedItems(runtime, provider, SESSION)
  const locked = runtime.promptDelivery.kind === 'sending'
  return (
    <>
      <Feed
        sessionId={SESSION}
        provider={provider}
        entries={[]}
        renderItemsOverride={plan.items}
        pendingEntryUuid={
          runtime.promptDelivery.kind === 'sending'
            ? optimisticPromptUuid(runtime.promptDelivery.submissionId)
            : null
        }
      />
      <ComposerInput
        sessionId={SESSION}
        inputRef={{ current: null }}
        input={locked ? '' : input}
        focused
        slashMode={keys.slashMode}
        provider={provider}
        draftImages={locked ? [] : runtime.draftImages}
        pickerState={null}
        historyIndex={null}
        history={[]}
        setInputText={setInputText}
        endHistoryCycle={() => {}}
        onKeyDown={keys.onKeyDown}
        onPaste={() => {}}
        onFocusRequest={() => {}}
        onUserEngagement={() => {}}
        onHoverChange={() => {}}
        removeDraftImage={() => {}}
        dictation={{ enabled: false, busy: false, status: 'idle', levels: [], handleShortcut: () => false } as never}
        promptSuggestion={null}
        onApplySuggestion={() => {}}
        onDismissSuggestion={() => {}}
        promptDelivery={runtime.promptDelivery}
        onResolveUncertainDelivery={() => {}}
        locked={locked}
      />
    </>
  )
}

function Controller({ provider }: { provider: AgentProviderKind }) {
  current = useWorkspace(false)
  return (
    <>
      {current.runtimeServices}
      <Pane workspace={current} provider={provider} />
    </>
  )
}

function seed(provider: AgentProviderKind, runtime: Partial<SessionRuntime> = {}) {
  const state: WorkspaceState = { ...original.workspaceState,
    tabs: [{ id: 'tab', title: 'Test' }], activeTabId: 'tab',
    sessions: { [SESSION]: { kind: provider, cwd: '/repo', projectId: 'tab', joinedAt: 0 } },
    stage: oneLaneStage(SESSION),
  }
  useAppStore.setState({
    workspaceState: state,
    workspaceRuntimes: { [SESSION]: { ...emptyRuntime(), processStatus: 'started', inputReady: true, ...runtime } },
  })
}

/** A fake feed whose deliverPrompt stays pending until the test settles it. */
function heldFeed(): { feed: FakeSessionFeed; settle: (result: PromptDeliveryResult) => Promise<void> } {
  const feed = createFakeSessionFeed()
  let resolve!: (result: PromptDeliveryResult) => void
  feed.deliverPrompt = async (sessionId, prompt) => {
    feed.calls.push({ method: 'deliverPrompt', sessionId, prompt })
    return new Promise<PromptDeliveryResult>(r => { resolve = r })
  }
  return {
    feed,
    settle: async result => { await act(async () => { resolve(result) }) },
  }
}

function mount(provider: AgentProviderKind, feed: FakeSessionFeed) {
  return render(
    <SessionFeedProvider value={feed}>
      <Controller provider={provider} />
    </SessionFeedProvider>,
  )
}

const composer = () => screen.getByRole('textbox') as HTMLTextAreaElement
const IMAGE = { id: 'img-1', base64Data: 'AAAA', mediaType: 'image/png', filename: 'x.png', previewUrl: 'data:image/png;base64,AAAA' }
const BEFORE_WRITE_FAILURE: PromptDeliveryResult = {
  ok: false,
  stage: 'before-write',
  code: 'not-ready',
  message: 'Agent is not ready for input',
  retrySafe: true,
  disposition: 'retry-same-session',
  promptWritten: false,
  enterWritten: false,
}

beforeEach(() => {
  sendSpy = vi.fn<SendFn>(async () => {})
  const api = new Proxy({} as Record<string, unknown>, {
    get: (_t, key) => {
      if (key === 'saveClaudeImage') return async () => ({ path: '/tmp/img.png' })
      if (typeof key === 'string' && key.startsWith('on')) return () => () => undefined
      return async () => undefined
    },
  })
  Object.defineProperty(window, 'api', { configurable: true, value: api })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(original, true)
  Object.defineProperty(window, 'api', { configurable: true, value: originalApi })
})

describe('Claude submit while the delivery is in flight', () => {
  it('moves the prompt from the composer into the feed as a dimmed Sending row, and locks the composer', async () => {
    seed('claude')
    const { feed, settle } = heldFeed()
    mount('claude', feed)
    act(() => current.setDraftInput(SESSION, 'refactor the parser'))

    let pending!: Promise<void>
    act(() => { pending = submit('textarea-enter') })
    await act(async () => {})

    // The composer SHOWS nothing and is read-only, while the store keeps the
    // draft: that copy is what autosave persists, so a reload mid-send cannot
    // lose the prompt (PR #1183 review).
    expect(composer().value).toBe('')
    expect(composer().readOnly).toBe(true)
    expect(current.getRuntime(SESSION).draftInput).toBe('refactor the parser')
    // The prompt is in the feed at once, marked as not yet sent. Claude had
    // no row at all here before #1181.
    const row = screen.getByText('refactor the parser')
    expect(row.closest('[aria-busy="true"]')).not.toBeNull()
    expect(screen.getByText('Sending…')).toBeTruthy()

    await settle({ ok: true, acceptance: { kind: 'user', acceptedAt: Date.now() } })
    await act(async () => { await pending })

    // Accepted: the pending-only row is gone (Claude's committed row takes
    // over; the IPC fold is mocked here, so nothing replaces it in this test),
    // the caption is gone, and the composer is editable again.
    expect(screen.queryByText('Sending…')).toBeNull()
    expect(current.getRuntime(SESSION).entries.some(e => e.uuid?.startsWith('optimistic-codex-user:'))).toBe(false)
    expect(composer().readOnly).toBe(false)
    expect(current.getRuntime(SESSION).draftInput).toBe('')
    expect(current.getRuntime(SESSION).promptDelivery.kind).toBe('idle')
  })

  it('keeps text another writer added to the draft during the send, but not the sent prompt', async () => {
    // Dictation writes draftInput directly, past the locked textarea. Those
    // words are the next prompt and must survive the acceptance.
    seed('claude')
    const { feed, settle } = heldFeed()
    mount('claude', feed)
    act(() => current.setDraftInput(SESSION, 'first prompt'))
    let pending!: Promise<void>
    act(() => { pending = submit('textarea-enter') })
    await act(async () => {})
    act(() => current.setDraftInput(SESSION, 'first prompt and then more'))

    await settle({ ok: true, acceptance: { kind: 'user', acceptedAt: Date.now() } })
    await act(async () => { await pending })

    expect(current.getRuntime(SESSION).draftInput).toBe('and then more')
    expect(composer().value).toBe('and then more')
  })

  it('a failed send removes the pending row and puts the text and images back in the composer', async () => {
    seed('claude')
    const { feed, settle } = heldFeed()
    mount('claude', feed)
    act(() => {
      current.setDraftInput(SESSION, 'this will fail')
      current.setDraftImages(SESSION, [IMAGE])
    })

    let pending!: Promise<void>
    act(() => { pending = submit('textarea-enter') })
    await act(async () => {})
    // Hidden from the view, never removed from the store.
    expect(composer().value).toBe('')
    expect(screen.queryByAltText('x.png')).toBeNull()
    expect(current.getRuntime(SESSION).draftImages).toEqual([IMAGE])

    await settle(BEFORE_WRITE_FAILURE)
    await act(async () => { await pending })

    const runtime = current.getRuntime(SESSION)
    expect(runtime.draftInput).toBe('this will fail')
    expect(runtime.draftImages).toEqual([IMAGE])
    expect(composer().value).toBe('this will fail')
    expect(screen.getByAltText('x.png')).toBeTruthy()
    expect(runtime.entries.some(e => e.uuid?.startsWith('optimistic-codex-user:'))).toBe(false)
    expect(screen.queryByText('Sending…')).toBeNull()
    expect(composer().readOnly).toBe(false)
  })

  it('a queue acceptance unlocks the composer and hands the prompt to Claude\'s queue', async () => {
    seed('claude', { streamPhase: 'thinking', turnStartedAt: 1_000_000 })
    const { feed, settle } = heldFeed()
    mount('claude', feed)
    act(() => current.setDraftInput(SESSION, 'queued behind a running turn'))

    let pending!: Promise<void>
    act(() => { pending = submit('textarea-enter') })
    await act(async () => {})
    expect(screen.getByText('Sending…')).toBeTruthy()

    await settle({ ok: true, acceptance: { kind: 'queue', acceptedAt: Date.now() } })
    await act(async () => { await pending })

    // Decision C: no lock behind a turn that may run for minutes. The queued
    // prompt is Claude's queue-operation strip's to show from here on.
    expect(composer().readOnly).toBe(false)
    expect(screen.queryByText('Sending…')).toBeNull()
    expect(current.getRuntime(SESSION).entries.some(e => e.uuid?.startsWith('optimistic-codex-user:'))).toBe(false)
  })
})

describe('the composer lock', () => {
  it('ignores every key that would edit the draft or write to the agent', async () => {
    seed('claude', { promptSuggestion: { text: 'suggested next prompt' } as SessionRuntime['promptSuggestion'] })
    const { feed, settle } = heldFeed()
    mount('claude', feed)
    act(() => current.setDraftInput(SESSION, 'first'))
    let pending!: Promise<void>
    act(() => { pending = submit('textarea-enter') })
    await act(async () => {})
    sendSpy.mockClear()

    // `/` on an empty draft normally enters slash mode by writing to the PTY,
    // and Tab normally prefills the suggestion. Both reach around a read-only
    // textarea, so the lock has to stop them in the key handler.
    // Escape and Ctrl+C are included: main refuses raw writes for the whole
    // Claude delivery, so they could not reach the agent anyway and only
    // produced a false "draft preserved" toast (PR #1183 review).
    for (const key of ['/', 'Tab', 'Enter', 'Escape']) {
      await act(async () => { fireEvent.keyDown(composer(), { key }) })
    }
    await act(async () => { fireEvent.keyDown(composer(), { key: 'c', ctrlKey: true }) })
    expect(sendSpy).not.toHaveBeenCalled()
    expect(current.getRuntime(SESSION).draftInput).toBe('first')
    expect(feed.calls.filter(c => c.method === 'deliverPrompt')).toHaveLength(1)

    await settle({ ok: true, acceptance: { kind: 'user', acceptedAt: Date.now() } })
    await act(async () => { await pending })

    // Control: once unlocked, the same keys act again. Without this the
    // assertions above would pass against a handler that ignores them always.
    await act(async () => { fireEvent.keyDown(composer(), { key: 'Tab' }) })
    expect(current.getRuntime(SESSION).draftInput).toBe('suggested next prompt')
    await act(async () => { fireEvent.keyDown(composer(), { key: 'Escape' }) })
    expect(sendSpy).toHaveBeenCalledWith('\x1b')
  })
})

describe('echo providers', () => {
  it('dim the optimistic row that belongs to the in-flight submit, and undim it on acceptance', async () => {
    // OpenCode already minted an optimistic row. What is new is that its uuid
    // names the submission, so the row can be marked as still sending, and that
    // it stays (undimmed) after acceptance until the transcript catches up.
    seed('opencode')
    const { feed, settle } = heldFeed()
    mount('opencode', feed)
    act(() => current.setDraftInput(SESSION, 'run the tests'))

    let pending!: Promise<void>
    act(() => { pending = submit('textarea-enter') })
    await act(async () => {})

    const delivery = current.getRuntime(SESSION).promptDelivery
    expect(delivery.kind).toBe('sending')
    const uuid = optimisticPromptUuid(delivery.kind === 'sending' ? delivery.submissionId : '')
    expect(current.getRuntime(SESSION).entries.map(e => e.uuid)).toContain(uuid)
    expect(screen.getByText('run the tests').closest('[aria-busy="true"]')).not.toBeNull()
    expect(composer().readOnly).toBe(true)

    await settle({ ok: true, acceptance: { kind: 'transport', acceptedAt: Date.now() } })
    await act(async () => { await pending })

    expect(screen.getByText('run the tests').closest('[aria-busy="true"]')).toBeNull()
    expect(screen.queryByText('Sending…')).toBeNull()
    expect(current.getRuntime(SESSION).entries.map(e => e.uuid)).toContain(uuid)
    expect(composer().readOnly).toBe(false)
  })
})
