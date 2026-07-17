import type { SessionFeed } from '@shared/sessionFeed/SessionFeed'
import type {
  ConditionCustomAction,
  ResolveConditionResult,
  SessionConditionsEvent,
  SessionExitEvent,
  SessionJsonlEntriesEvent,
  SessionJsonlErrorEvent,
  SessionInputReadinessEvent,
  SessionProcessStateEvent,
  SessionScreenEvent,
  SessionSemanticEvent,
  SessionStartedEvent,
  SessionSubAgentsEvent,
  Unsub,
} from '@shared/sessionFeed/types'
import type { PromptDeliveryResult } from '@shared/types/providerConfig'

// In-memory SessionFeed for tests — the proof that the phase-0 decoupling
// worked: renderer code driven by this fake runs with no Electron, no IPC,
// no main process. Tests emit events with emit*() and assert on `calls`.
//
// Deliberately NOT a vi.mock/spy bundle: a real (if tiny) implementation of
// the contract exercises the same subscribe/unsubscribe lifecycles the
// production transports do, so a test passing against the fake means the
// component honoured the contract, not a mock's accidental shape.

export type FakeFeedCall =
  | { method: 'sendInput'; sessionId: string; data: string; pasteId: string | undefined }
  | { method: 'deliverPrompt'; sessionId: string; prompt: string }
  | { method: 'resolveCondition'; sessionId: string; action: ConditionCustomAction }

export interface FakeSessionFeed extends SessionFeed {
  /** Every command invocation, in order — assert on this. */
  calls: FakeFeedCall[]
  /** Override the canned command results when a test needs failure paths. */
  nextSendInputResult: boolean
  nextDeliverPromptResult: PromptDeliveryResult
  nextResolveConditionResult: ResolveConditionResult
  emitStarted(e: SessionStartedEvent): void
  emitInputReadiness(e: SessionInputReadinessEvent): void
  emitScreen(e: SessionScreenEvent): void
  emitJsonlEntries(e: SessionJsonlEntriesEvent): void
  emitJsonlError(e: SessionJsonlErrorEvent): void
  emitSemantic(e: SessionSemanticEvent): void
  emitConditions(e: SessionConditionsEvent): void
  emitProcessState(e: SessionProcessStateEvent): void
  emitSubAgents(e: SessionSubAgentsEvent): void
  emitExit(e: SessionExitEvent): void
}

export function createFakeSessionFeed(): FakeSessionFeed {
  // One listener set per event type, mirroring the contract's global
  // one-listener-per-type shape. A Set gives us O(1) unsubscribe and the
  // same "late subscribers miss earlier events" semantics as the real
  // transports — no replay, because the contract doesn't promise one.
  const listeners = {
    started: new Set<(e: SessionStartedEvent) => void>(),
    inputReadiness: new Set<(e: SessionInputReadinessEvent) => void>(),
    screen: new Set<(e: SessionScreenEvent) => void>(),
    jsonlEntries: new Set<(e: SessionJsonlEntriesEvent) => void>(),
    jsonlError: new Set<(e: SessionJsonlErrorEvent) => void>(),
    semantic: new Set<(e: SessionSemanticEvent) => void>(),
    conditions: new Set<(e: SessionConditionsEvent) => void>(),
    processState: new Set<(e: SessionProcessStateEvent) => void>(),
    subAgents: new Set<(e: SessionSubAgentsEvent) => void>(),
    exit: new Set<(e: SessionExitEvent) => void>(),
  }

  function subscribe<E>(set: Set<(e: E) => void>, cb: (e: E) => void): Unsub {
    set.add(cb)
    return () => set.delete(cb)
  }

  function emit<E>(set: Set<(e: E) => void>, e: E): void {
    // Copy before iterating so a listener unsubscribing (or subscribing a
    // sibling) mid-dispatch can't mutate the live set under the loop.
    for (const cb of [...set]) cb(e)
  }

  const feed: FakeSessionFeed = {
    calls: [],
    nextSendInputResult: true,
    nextDeliverPromptResult: {
      ok: true,
      acceptance: { kind: 'transport', acceptedAt: 123 },
    },
    nextResolveConditionResult: { ok: true },

    onSessionStarted: cb => subscribe(listeners.started, cb),
    onSessionInputReadiness: cb => subscribe(listeners.inputReadiness, cb),
    onSessionScreen: cb => subscribe(listeners.screen, cb),
    onSessionJsonlEntries: cb => subscribe(listeners.jsonlEntries, cb),
    onSessionJsonlError: cb => subscribe(listeners.jsonlError, cb),
    onSessionSemanticEvent: cb => subscribe(listeners.semantic, cb),
    onSessionConditions: cb => subscribe(listeners.conditions, cb),
    onSessionProcessState: cb => subscribe(listeners.processState, cb),
    onSessionSubAgents: cb => subscribe(listeners.subAgents, cb),
    onSessionExit: cb => subscribe(listeners.exit, cb),

    sendInput: async (sessionId, data, pasteId) => {
      feed.calls.push({ method: 'sendInput', sessionId, data, pasteId })
      return feed.nextSendInputResult
    },
    deliverPrompt: async (sessionId, prompt) => {
      feed.calls.push({ method: 'deliverPrompt', sessionId, prompt })
      return feed.nextDeliverPromptResult
    },
    resolveCondition: async (sessionId, action) => {
      feed.calls.push({ method: 'resolveCondition', sessionId, action })
      return feed.nextResolveConditionResult
    },

    emitStarted: e => emit(listeners.started, e),
    emitInputReadiness: e => emit(listeners.inputReadiness, e),
    emitScreen: e => emit(listeners.screen, e),
    emitJsonlEntries: e => emit(listeners.jsonlEntries, e),
    emitJsonlError: e => emit(listeners.jsonlError, e),
    emitSemantic: e => emit(listeners.semantic, e),
    emitConditions: e => emit(listeners.conditions, e),
    emitProcessState: e => emit(listeners.processState, e),
    emitSubAgents: e => emit(listeners.subAgents, e),
    emitExit: e => emit(listeners.exit, e),
  }
  return feed
}
