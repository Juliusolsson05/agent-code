import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/hooks'
import { SessionFeedProvider } from '@renderer/features/sessionFeed/SessionFeedContext'
import { createFakeSessionFeed } from '@renderer/features/sessionFeed/FakeSessionFeed'
import type { FakeSessionFeed } from '@renderer/features/sessionFeed/FakeSessionFeed'
import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import { reduceStreamPhase } from '@renderer/session-runtime/semantic/streamPhaseMachine'
import type { TileNode, WorkspaceState } from '@renderer/workspace/types'
import type { SessionId } from '@renderer/workspace/types'
import { useWorkspace } from '@renderer/workspace/hook'
import { useSessionRuntime } from '@renderer/workspace/useSessionRuntime'

import { useComposerKeybinds } from './useComposerKeybinds'

// The recorded 2026-09-11 incident (#889 / #890): a prompt submitted while
// Claude was mid-turn was accepted into Claude's QUEUE (paste-debug 181e3d52,
// `delivery:acceptance-queue` at +208 ms). The pane then painted `Sending · 27s`
// over a turn that was busy thinking, and the user re-sent the prompt.
//
// This suite drives the REAL workspace controller and the REAL composer submit
// hook with a fake feed that answers exactly the way main did, and pins the two
// contracts the incident exposed:
//
//   1. The composer clear is unconditional on acceptance kind. Text AND the
//      draft image go, the delivery state returns to idle. (This is the probe
//      that ruled the composer clear out as the cause; it stays as a permanent
//      contract so nobody re-derives that proof.)
//   2. A queue acceptance never leaves the pane claiming `Sending`. Over a live
//      turn the optimistic phase is not stamped at all (the turn's own phase and
//      elapsed time stay); on a pane the renderer believed idle the stamped
//      `submitting` is settled back to idle when the acceptance says `queue`.
//
// WHY the controller is real and only ingress is faked: the bug lived in the
// hand-off between the optimistic stamp, the delivery result and the store —
// a hook rendered against a stub workspace cannot see that hand-off.

vi.mock('@renderer/workspace/hook/ipc/useIpcSubscriptions', () => ({ useIpcSubscriptions: () => undefined }))
vi.mock('@renderer/workspace/hook/ipc/useWorkspaceAdoption', () => ({ useWorkspaceAdoption: () => undefined }))
vi.mock('@renderer/workspace/hook/persistence/useBootstrap', async () => {
  const { useEffect } = await import('react')
  return { useBootstrap: (...args: Parameters<typeof import('@renderer/workspace/hook/persistence/useBootstrap').useBootstrap>) => {
    useEffect(() => args[5](true), [args[5]])
  } }
})

const SESSION = '35a552fe-b207-4c1c-b8f5-8a7086037555' as SessionId
const original = useAppStore.getState()
const originalApi = window.api

let current!: ReturnType<typeof useWorkspace>
let submit!: (source: 'textarea-enter' | 'global-enter' | 'button') => Promise<void>
let renderedInput = ''
type LifecycleReport = { name: string; data?: Record<string, unknown> }
let lifecycleReports: LifecycleReport[] = []

// The journaled `submit.result` of the most recent submit, as it crossed the
// preload bridge: after report.ts's allowlist filtering, which is the filter
// that silently drops a renamed or unlisted key.
function lastSubmitResult(): Record<string, unknown> | undefined {
  return lifecycleReports.filter(r => r.name === 'submit.result').at(-1)?.data
}

function Composer({ workspace }: { workspace: ReturnType<typeof useWorkspace> }) {
  // Mirrors TileLeaf exactly: `input` IS runtime.draftInput and setInputText
  // writes through to the store. Diverging here would test a composer the app
  // does not ship.
  const runtime = useSessionRuntime(workspace, SESSION)
  const input = runtime.draftInput
  renderedInput = input
  const setInputText = (next: string) => workspace.setDraftInput(SESSION, next)
  const keys = useComposerKeybinds({
    sessionId: SESSION,
    provider: 'claude',
    runtime,
    workspace,
    input,
    setInputText,
    send: async () => {},
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
  return <textarea data-testid="composer" value={input} readOnly />
}

function Controller() {
  current = useWorkspace(false)
  return (
    <>
      {current.runtimeServices}
      <Composer workspace={current} />
    </>
  )
}

function mount(feed: FakeSessionFeed) {
  return render(
    <SessionFeedProvider value={feed}>
      <Controller />
    </SessionFeedProvider>,
  )
}

function seed(runtime: Partial<SessionRuntime>) {
  const root: TileNode = { type: 'leaf', sessionId: SESSION }
  const state: WorkspaceState = { ...original.workspaceState,
    tabs: [{ id: 'tab', title: 'Test', focusedSessionId: SESSION, root }], activeTabId: 'tab',
    sessions: { [SESSION]: { kind: 'claude', cwd: '/repo' } },
  }
  useAppStore.setState({
    workspaceState: state,
    workspaceRuntimes: { [SESSION]: { ...emptyRuntime(), processStatus: 'started', inputReady: true, ...runtime } },
  })
}

const IMAGE = { id: 'img-1', base64Data: 'AAAA', mediaType: 'image/png', filename: 'x.png', previewUrl: 'blob:x' }

function feedAccepting(kind: 'user' | 'queue') {
  const feed = createFakeSessionFeed()
  feed.nextDeliverPromptResult = { ok: true, acceptance: { kind, acceptedAt: Date.now() } }
  return feed
}

beforeEach(() => {
  lifecycleReports = []
  const api = new Proxy({} as Record<string, unknown>, {
    get: (_t, key) => {
      if (key === 'saveClaudeImage') return async () => ({ path: '/tmp/img.png' })
      // Captured, not swallowed: the `acceptance` field on submit.result is the
      // journal evidence #889 needed, and only the bridge payload shows whether
      // it survived the allowlist (#893 review F4).
      if (key === 'reportSessionLifecycle') return (report: LifecycleReport) => { lifecycleReports.push(report) }
      // Every `on*` subscription must hand back an unsubscribe or effect
      // cleanup throws and the whole tree comes down mid-test.
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

describe('composer submit accepted into the provider queue', () => {
  it.each(['user', 'queue'] as const)('acceptance=%s clears the text and the draft image and idles the delivery state', async kind => {
    seed({})
    const feed = feedAccepting(kind)
    mount(feed)
    act(() => {
      current.setDraftInput(SESSION, 'hello queued world')
      current.setDraftImages(SESSION, [IMAGE])
    })
    expect(renderedInput).toBe('hello queued world')

    await act(async () => { await submit('textarea-enter') })

    expect(feed.calls.filter(c => c.method === 'deliverPrompt')).toHaveLength(1)
    const runtime = current.getRuntime(SESSION)
    expect(runtime.draftInput).toBe('')
    expect(runtime.draftImages).toEqual([])
    expect(runtime.promptDelivery.kind).toBe('idle')
    expect(renderedInput).toBe('')
    // The journal records which acceptance this was.
    expect(lastSubmitResult()).toMatchObject({ provider: 'claude', ok: true, acceptance: kind })
  })

  it('over a live turn, never paints Sending: the turn keeps its phase and its clock', async () => {
    // The incident pane: Claude had been thinking for a while when the user
    // pressed Enter. `turnStartedAt` is the value the WorkIndicator times from.
    seed({ streamPhase: 'thinking', turnStartedAt: 1_000_000, phaseChangedAt: 1_000_500 })
    mount(feedAccepting('queue'))
    act(() => current.setDraftInput(SESSION, 'queued behind a live turn'))

    const settled = submit('textarea-enter')
    // Before the acceptance lands the pane must ALREADY be truthful — the
    // 09:59 and 10:02 recordings show the lie starting at the optimistic stamp,
    // not at the acceptance.
    expect(current.getRuntime(SESSION).streamPhase).toBe('thinking')
    await act(async () => { await settled })

    const runtime = current.getRuntime(SESSION)
    expect(runtime.streamPhase).toBe('thinking')
    expect(runtime.turnStartedAt).toBe(1_000_000)
    expect(runtime.phaseChangedAt).toBe(1_000_500)
    expect(runtime.draftInput).toBe('')
  })

  it('on a pane the renderer believed idle, a queue acceptance settles the stamped Sending back to idle', async () => {
    // Claude can queue while the renderer sees no live turn (between turns
    // behind a spinner, during compaction). The optimistic stamp is legitimate
    // there, but once main says `queue` the claim is provably false and no
    // later event will correct it — a queued prompt starts no turn.
    seed({})
    mount(feedAccepting('queue'))
    act(() => current.setDraftInput(SESSION, 'queued while idle'))

    await act(async () => { await submit('textarea-enter') })

    const runtime = current.getRuntime(SESSION)
    expect(runtime.streamPhase).toBe('idle')
    expect(runtime.turnStartedAt).toBeNull()
    expect(runtime.submittedAt).toBeNull()
  })

  it('on an idle pane, a user acceptance keeps the optimistic Sending until the turn events arrive', async () => {
    // Control: the settle must be specific to `queue`. A `user` acceptance
    // means a turn is about to start and the stream-phase machine owns the
    // hand-off from `submitting` to the first real phase.
    seed({})
    mount(feedAccepting('user'))
    act(() => current.setDraftInput(SESSION, 'a normal prompt'))

    await act(async () => { await submit('textarea-enter') })

    expect(current.getRuntime(SESSION).streamPhase).toBe('submitting')
  })

  it('a queued second submit never settles the Sending an earlier submit still owns', async () => {
    // Codex review (major) / Claude F1. A resolves `user` and the composer
    // releases its in-flight guard before A's first provider event. B lands in
    // that gap, skips its own stamp, and Claude queues it. Neither main's
    // reservation nor the renderer guard prevents this: the two deliveries are
    // sequential and each one completed.
    seed({})
    const feed = feedAccepting('user')
    mount(feed)
    act(() => current.setDraftInput(SESSION, 'prompt A starts a turn'))
    await act(async () => { await submit('textarea-enter') })
    const stampA = current.getRuntime(SESSION).submittedAt
    expect(current.getRuntime(SESSION).streamPhase).toBe('submitting')
    expect(stampA).not.toBeNull()

    feed.nextDeliverPromptResult = { ok: true, acceptance: { kind: 'queue', acceptedAt: Date.now() } }
    act(() => current.setDraftInput(SESSION, 'prompt B queued behind A'))
    await act(async () => { await submit('textarea-enter') })

    expect(feed.calls.filter(c => c.method === 'deliverPrompt')).toHaveLength(2)
    const afterB = current.getRuntime(SESSION)
    expect(afterB.streamPhase).toBe('submitting')
    expect(afterB.submittedAt).toBe(stampA)
    expect(afterB.turnStartedAt).toBe(stampA)

    // A's first real event must still advance A's claim. The IPC fold is mocked
    // in this suite, so apply the same pure reducer it runs.
    act(() => {
      current.updateRuntime(
        SESSION,
        reduceStreamPhase(current.getRuntime(SESSION), { type: 'turn_started', turnId: 'msg_a' }, null),
      )
    })
    expect(current.getRuntime(SESSION).streamPhase).toBe('responding')
    expect(current.getRuntime(SESSION).turnStartedAt).toBe(stampA)
  })
})
