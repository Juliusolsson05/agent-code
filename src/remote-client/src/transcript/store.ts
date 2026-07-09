import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { foldSemanticEvent } from '@renderer/session-runtime/semantic/foldEvent'
import {
  reduceStreamPhase,
  type StreamPhaseState,
} from '@renderer/session-runtime/semantic/streamPhaseMachine'
import { indexEntryIntoMaps } from '@renderer/session-runtime/entries'
import {
  emptySemanticRuntime,
  type SemanticLiveTurn,
  type SemanticRuntimeState,
} from '@renderer/session-runtime/state'
import { isAgentProviderKind, type AgentProviderKind } from '@shared/types/providerKind'
import type { Entry, ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import type { ProviderConditionSnapshot } from '@shared/types/providerConditions'
import { asRecord } from '@shared/lib/asRecord'

import type { WebSocketSessionFeed } from '../WebSocketSessionFeed'

// The phone's per-session transcript model — the MINIMAL SessionRuntime
// that drives the desktop Feed (the field list comes from the TileLeaf →
// Feed prop map, TileLeaf.tsx:475-573; see the semantic-rendering design
// doc's "Client state model" for what is deliberately skipped and why).
//
// This store deliberately reuses the desktop's OWN reducers and mappers —
// foldSemanticEvent, reduceStreamPhase, the registry transcript mappers,
// indexEntryIntoMaps — so the phone's model can only diverge from the
// desktop's where this file visibly chooses to (skipped subsystems), never
// silently in shared logic.
//
// Ingest discipline (mirrors useIpcSubscriptions Pass B + the desktop
// history actions; every rule here traces to a desktop counterpart):
//   - ONE seen-uuid Set per session gates BOTH backfill and live entries.
//   - History PREPENDS, live APPENDS.
//   - The pagination anchor is the first chunk-raw that yielded KEPT
//     entries' historyMarker (desktop gates on mapped.length > 0).
//   - LIVE entries flow through one session-lifetime mapper (the codex
//     rolling turn cursor must survive across bursts); HISTORY chunks each
//     get a FRESH chunk-scoped mapper (the codex mapper's documented
//     contract — feeding old records through the live mapper stamps them
//     with the live turn id and corrupts the cursor both directions).
//   - A transcript ROLL (/clear, resume onto a new provider session) is
//     detected by comparing the `file` riding live frames and history
//     chunks; state resets so the old conversation cannot pollute the new.

export type SessionTranscript = {
  entries: Entry[]
  semanticTurn: SemanticLiveTurn | null
  semanticHistory: SemanticLiveTurn[]
  /** The full fold state, mirrored on exactly the ticks that update
   *  semanticTurn/semanticHistory above. Exposed since #493 PR-2 so
   *  SessionView can hand the ledger a REAL SemanticRuntimeState (the
   *  RuntimeRenderInput contract) instead of fabricating a partial
   *  {currentTurn, history} object behind an `as unknown as` cast. The
   *  two scalar mirrors stay because non-ledger surfaces read them. */
  semantic: SemanticRuntimeState
  phase: StreamPhaseState
  toolUseIndex: Map<string, ToolUseBlock>
  toolResultIndex: Map<string, ToolResultBlock>
  toolIndexVersion: number
  conditions: ProviderConditionSnapshot | null
  workingStatus: string | null
  /** Latest TUI text (`recent` window). The feed does NOT render this in
   *  normal operation — it is the fallback for pre-transcript states
   *  (trust dialog body, login errors, provider crashes) that never reach
   *  the jsonl/semantic channels. Dropping it entirely was a review
   *  finding: those states rendered as a blank feed. */
  screenText: string
  /** Why the last backfill attempt failed, or null. Shown by SessionView
   *  when the TUI-text fallback is on screen — a silent fallback is
   *  indistinguishable from the pre-semantic-rendering UI, which cost a
   *  real debugging session ("still just dumping the raw terminal?") when
   *  the phone was actually talking to an outdated backend. Benign
   *  no-transcript-yet failures are not recorded. */
  historyError: string | null
  exited: boolean
  hasOlderHistory: boolean
  loadingOlderHistory: boolean
  totalEntries: number
}

type SessionState = {
  transcript: SessionTranscript
  semantic: SemanticRuntimeState
  seen: Set<string>
  /** Session-lifetime mapper for LIVE entries only (codex cursor). Created
   *  lazily once the kind is KNOWN from the session list — memoizing a
   *  mapper built on a fallback guess would bake the wrong provider in for
   *  the session's lifetime (review finding). */
  liveMapper: Mapper | null
  kind: AgentProviderKind | null
  /** Durable transcript file identity, from live frames / history chunks.
   *  Disagreement between the two = the provider rolled the transcript. */
  transcriptFile: string | null
  historyOldestMarker: string | null
  historyLoaded: boolean
  historyLoading: boolean
}

type Mapper = ReturnType<
  ReturnType<typeof getRendererProviderCapabilities>['createTranscriptEntryMapper']
>

function emptyPhase(): StreamPhaseState {
  return {
    streamPhase: 'idle',
    streamPhasePendingToolName: null,
    streamPhasePendingToolUseId: null,
    turnStartedAt: null,
    phaseChangedAt: null,
    submittedAt: null,
  }
}

function emptyTranscript(): SessionTranscript {
  return {
    entries: [],
    semanticTurn: null,
    semanticHistory: [],
    semantic: emptySemanticRuntime(),
    phase: emptyPhase(),
    toolUseIndex: new Map(),
    toolResultIndex: new Map(),
    toolIndexVersion: 0,
    conditions: null,
    workingStatus: null,
    screenText: '',
    historyError: null,
    exited: false,
    hasOlderHistory: false,
    loadingOlderHistory: false,
    totalEntries: 0,
  }
}

export class TranscriptStore {
  private readonly sessions = new Map<string, SessionState>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly unsubs: Array<() => void> = []

  constructor(private readonly feed: WebSocketSessionFeed) {
    this.unsubs.push(
      feed.onSessionJsonlEntries(e => {
        this.ingestLiveEntries(e.sessionId, e.entries as Array<{ entry: unknown; file: string }>)
      }),
      feed.onSessionSemanticEvent(e => {
        this.ingestSemanticEvent(e.sessionId, e.event)
      }),
      feed.onSessionConditions(e => {
        this.mutate(e.sessionId, t => ({ ...t, conditions: e.snapshot }))
      }),
      feed.onSessionProcessState(e => {
        this.mutate(e.sessionId, t => ({
          ...t,
          workingStatus: e.active ? (e.status ?? 'Working') : null,
        }))
      }),
      feed.onSessionScreen(e => {
        this.mutate(e.sessionId, t =>
          t.screenText === e.recent ? t : { ...t, screenText: e.recent },
        )
      }),
      feed.onSessionExit(e => {
        // Mirror the desktop's exit boundary: dead processes own no live
        // turn, no phase, no prompts (useIpcSubscriptions offExit).
        const state = this.state(e.sessionId)
        state.semantic = { ...state.semantic, currentTurn: null }
        const clearedSemantic = state.semantic
        this.mutate(e.sessionId, t => ({
          ...t,
          exited: true,
          workingStatus: null,
          phase: emptyPhase(),
          semanticTurn: null,
          semantic: clearedSemantic,
          conditions: null,
        }))
      }),
      // Eviction + backfill retry both key off the session list, which the
      // server re-sends on every (re)connect and patches on started/exit/
      // removed. Sessions gone from the list are GONE from the manager —
      // holding their entries/seen-sets/mappers forever was unbounded
      // growth (review finding).
      feed.onSessionList(sessions => {
        const live = new Set(sessions.map(s => s.sessionId))
        for (const sessionId of [...this.sessions.keys()]) {
          if (!live.has(sessionId)) {
            this.sessions.delete(sessionId)
            this.listeners.delete(sessionId)
          }
        }
        // Reconnect/retry hook: a backfill that failed while the socket was
        // down stays failed forever without this — SessionView only calls
        // loadInitialHistory once per mount (review finding). The list
        // frame doubles as the "connection is live again" signal.
        for (const [sessionId, state] of this.sessions) {
          if (!state.historyLoaded && !state.historyLoading && this.listeners.has(sessionId)) {
            void this.loadInitialHistory(sessionId)
          }
        }
      }),
    )
  }

  dispose(): void {
    for (const unsub of this.unsubs) unsub()
    this.listeners.clear()
    this.sessions.clear()
  }

  // --- useSyncExternalStore surface ---

  subscribe(sessionId: string, cb: () => void): () => void {
    let set = this.listeners.get(sessionId)
    if (!set) {
      set = new Set()
      this.listeners.set(sessionId, set)
    }
    set.add(cb)
    return () => set?.delete(cb)
  }

  getSnapshot(sessionId: string): SessionTranscript {
    return this.state(sessionId).transcript
  }

  /** Resolved provider kind (list-backed; 'claude' until the list lands —
   *  the server sends the list before any session event on every connect,
   *  so the fallback window is one frame). Exposed so SessionView doesn't
   *  duplicate the lookup (review finding). */
  getKind(sessionId: string): AgentProviderKind {
    return this.kindOf(sessionId) ?? 'claude'
  }

  // --- backfill ---

  /** Load the initial newest-N chunk once per session. Prepends behind any
   *  live entries that already arrived — the shared seen-set makes the
   *  overlap safe, exactly like the desktop's initialHistory action.
   *  Failure leaves the flags retryable; retries fire from the session-list
   *  hook above and from live-entry arrival. */
  async loadInitialHistory(sessionId: string): Promise<void> {
    const state = this.state(sessionId)
    if (state.historyLoaded || state.historyLoading) return
    state.historyLoading = true
    this.mutate(sessionId, t => ({ ...t, loadingOlderHistory: true }))
    const result = await this.feed.getHistory(sessionId, { limit: 120 })
    state.historyLoading = false
    if (!result.ok) {
      // "No transcript yet" is normal for a brand-new session — live frames
      // will populate the feed and their arrival retries the backfill.
      // Anything ELSE (unknown message type on an old backend, disk error,
      // timeout) is surfaced so the fallback view can explain itself.
      const benign = /no transcript/i.test(result.error)
      this.mutate(sessionId, t => ({
        ...t,
        loadingOlderHistory: false,
        historyError: benign ? null : result.error,
      }))
      return
    }
    if (this.chunkFileConflicts(state, result.chunk.file)) {
      // The server's transcript-file cache was stale (post-/clear window):
      // the chunk is the PREVIOUS conversation. Discard it; live frames own
      // the file identity and a later retry will read the right file.
      this.mutate(sessionId, t => ({ ...t, loadingOlderHistory: false }))
      return
    }
    state.historyLoaded = true
    if (state.transcriptFile === null && typeof result.chunk.file === 'string') {
      state.transcriptFile = result.chunk.file
    }
    const marker = this.ingestRawEntries(
      sessionId,
      result.chunk.entries as Array<Record<string, unknown>>,
      'prepend',
    )
    if (marker) state.historyOldestMarker = marker
    this.mutate(sessionId, t => ({
      ...t,
      loadingOlderHistory: false,
      historyError: null,
      // Desktop guard (history.ts): a chunk with more history but NO usable
      // marker cannot be paged — advertising the affordance would render a
      // permanently dead control.
      hasOlderHistory: result.chunk.hasMore && state.historyOldestMarker !== null,
      totalEntries: result.chunk.totalEntries ?? t.entries.length,
    }))
  }

  async loadOlderHistory(sessionId: string): Promise<void> {
    const state = this.state(sessionId)
    if (state.transcript.loadingOlderHistory || !state.transcript.hasOlderHistory) return
    const beforeMarker = state.historyOldestMarker
    if (!beforeMarker) {
      // Should be unreachable (hasOlderHistory implies a marker per the
      // initial-load guard) — but if it happens, kill the affordance
      // instead of leaving a silently dead button (review finding).
      this.mutate(sessionId, t => ({ ...t, hasOlderHistory: false }))
      return
    }
    this.mutate(sessionId, t => ({ ...t, loadingOlderHistory: true }))
    const result = await this.feed.getHistory(sessionId, { beforeMarker, limit: 200 })
    if (!result.ok || this.chunkFileConflicts(state, result.chunk?.file)) {
      this.mutate(sessionId, t => ({ ...t, loadingOlderHistory: false }))
      return
    }
    const marker = this.ingestRawEntries(
      sessionId,
      result.chunk.entries as Array<Record<string, unknown>>,
      'prepend',
    )
    if (marker) state.historyOldestMarker = marker
    this.mutate(sessionId, t => ({
      ...t,
      loadingOlderHistory: false,
      // hasMore from the chunk is authoritative — an all-duplicate page
      // must NOT re-enable loading (same invariant as the desktop's
      // history action documents) — but a missing next marker still kills
      // the affordance.
      hasOlderHistory: result.chunk.hasMore && state.historyOldestMarker !== null,
    }))
  }

  // --- internals ---

  private state(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = {
        transcript: emptyTranscript(),
        semantic: emptySemanticRuntime(),
        seen: new Set(),
        liveMapper: null,
        kind: null,
        transcriptFile: null,
        historyOldestMarker: null,
        historyLoaded: false,
        historyLoading: false,
      }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  private kindOf(sessionId: string): AgentProviderKind | null {
    const state = this.state(sessionId)
    if (state.kind) return state.kind
    const listed = this.feed.getSessionList().find(s => s.sessionId === sessionId)?.kind
    if (listed && isAgentProviderKind(listed)) {
      state.kind = listed
      return listed
    }
    return null
  }

  private liveMapperOf(sessionId: string): Mapper {
    const state = this.state(sessionId)
    if (state.liveMapper) return state.liveMapper
    const kind = this.kindOf(sessionId)
    if (kind) {
      // Kind is KNOWN — safe to memoize for the session's lifetime (the
      // codex rolling turn cursor must survive across live bursts).
      state.liveMapper = getRendererProviderCapabilities(kind).createTranscriptEntryMapper()
      return state.liveMapper
    }
    // Kind unknown (list not landed yet — one-frame window at most): use a
    // TRANSIENT claude-default mapper and do NOT memoize, so the real kind
    // still wins once known. The claude mapper is stateless, so a transient
    // instance loses nothing.
    return getRendererProviderCapabilities('claude').createTranscriptEntryMapper()
  }

  /** Fresh chunk-scoped mapper — the desktop's rule for history chunks
   *  (initialHistory.ts / history.ts both document it): the codex turn
   *  cursor must start null per chunk so old records never get stamped
   *  with the live turn id, and the live cursor never inherits a stale
   *  historical one. */
  private chunkMapper(sessionId: string): Mapper {
    const kind = this.kindOf(sessionId) ?? 'claude'
    return getRendererProviderCapabilities(kind).createTranscriptEntryMapper()
  }

  private chunkFileConflicts(state: SessionState, chunkFile: unknown): boolean {
    return (
      typeof chunkFile === 'string' &&
      state.transcriptFile !== null &&
      chunkFile !== state.transcriptFile
    )
  }

  private ingestLiveEntries(
    sessionId: string,
    items: Array<{ entry: unknown; file: string }>,
  ): void {
    if (items.length === 0) return
    const state = this.state(sessionId)

    const file = items[items.length - 1]?.file
    if (typeof file === 'string' && file.length > 0) {
      if (state.transcriptFile !== null && state.transcriptFile !== file) {
        // Transcript ROLL: /clear or a resume minted a new provider session
        // and a new jsonl file. The old conversation's entries, seen-set,
        // markers, and mapper cursor all belong to the dead transcript —
        // reset so the new conversation starts clean, then let the backfill
        // retry pick up the new file's history.
        this.resetTranscript(sessionId)
      }
      this.state(sessionId).transcriptFile = file
    }

    this.ingestRawEntries(
      sessionId,
      items.map(x => x.entry as Record<string, unknown>),
      'append',
    )

    // Live-entry arrival is also the backfill retry trigger for sessions
    // whose initial get-history failed with "no transcript on disk yet".
    const fresh = this.state(sessionId)
    if (!fresh.historyLoaded && !fresh.historyLoading && this.listeners.has(sessionId)) {
      void this.loadInitialHistory(sessionId)
    }
  }

  private resetTranscript(sessionId: string): void {
    const prev = this.state(sessionId)
    this.sessions.set(sessionId, {
      transcript: {
        ...emptyTranscript(),
        // Non-transcript surfaces survive the roll — the process didn't die.
        conditions: prev.transcript.conditions,
        workingStatus: prev.transcript.workingStatus,
        screenText: prev.transcript.screenText,
      },
      // The fold state resets WITH the transcript (review finding — this used
      // to carry prev.semantic across the roll). ingestSemanticEvent folds
      // onto state.semantic, so keeping the old runtime meant the FIRST
      // semantic event after a /clear re-published the dead conversation's
      // currentTurn + history into the fresh transcript's mirrors — the old
      // conversation's rows reappearing on the phone right after the desktop
      // cleared them.
      //
      // Mid-turn safety, traced: roll detection rides the first live jsonl
      // frame whose `file` differs, and a new conversation's first jsonl
      // write (the prompt entry at submit time, or the resumed history on
      // resume) is flushed BEFORE the provider's response begins — while the
      // new turn's semantic events only start with that response stream
      // (`turn_started` ≈ message_start, a full API roundtrip later). So in
      // the normal path this reset runs before any new-turn semantic event
      // exists, and everything it wipes belongs to the OLD conversation —
      // exactly the intent. If jsonl-watcher latency ever inverted that
      // ordering, the loss is bounded and self-healing: foldSemanticEvent
      // re-opens a turn from later `turn_started`/`turn_delta` events, and
      // the turn's content still commits through the jsonl entries — a brief
      // live-streaming gap versus guaranteed cross-conversation contamination
      // the other way.
      semantic: emptySemanticRuntime(),
      seen: new Set(),
      liveMapper: null,
      kind: prev.kind,
      transcriptFile: null,
      historyOldestMarker: null,
      historyLoaded: false,
      historyLoading: false,
    })
    const set = this.listeners.get(sessionId)
    if (set) for (const cb of [...set]) cb()
  }

  /** Map + dedupe + index a batch of raw records. Returns the pagination
   *  marker for prepend chunks (first raw that yielded KEPT entries —
   *  desktop's initialHistory.ts:178 gate). */
  private ingestRawEntries(
    sessionId: string,
    raws: Array<Record<string, unknown>>,
    mode: 'append' | 'prepend',
  ): string | null {
    if (raws.length === 0) return null
    const state = this.state(sessionId)
    const mapper = mode === 'append' ? this.liveMapperOf(sessionId) : this.chunkMapper(sessionId)

    const kept: Entry[] = []
    let firstKeptMarker: string | null = null
    let toolIndexChanged = false

    for (const raw of raws) {
      const mapped = mapper.map(raw)
      if (
        mode === 'prepend' &&
        firstKeptMarker === null &&
        mapped.entries.length > 0 &&
        mapped.historyMarker
      ) {
        firstKeptMarker = mapped.historyMarker
      }
      for (const entry of mapped.entries) {
        const uuid = typeof entry.uuid === 'string' ? entry.uuid : null
        if (uuid) {
          if (state.seen.has(uuid)) continue
          state.seen.add(uuid)
        }
        kept.push(entry)
        if (
          indexEntryIntoMaps(
            entry,
            state.transcript.toolUseIndex,
            state.transcript.toolResultIndex,
          )
        ) {
          toolIndexChanged = true
        }
      }
    }

    if (kept.length === 0 && !toolIndexChanged) return firstKeptMarker

    this.mutate(sessionId, t => ({
      ...t,
      entries: mode === 'append' ? [...t.entries, ...kept] : [...kept, ...t.entries],
      totalEntries: t.totalEntries + (mode === 'append' ? kept.length : 0),
      toolIndexVersion: toolIndexChanged ? t.toolIndexVersion + 1 : t.toolIndexVersion,
    }))
    return firstKeptMarker
  }

  private ingestSemanticEvent(sessionId: string, event: unknown): void {
    const state = this.state(sessionId)
    const record = asRecord(event)
    if (!record) return

    // Desktop order: fold first, then the shared phase machine over the
    // POST-fold turn (reduceStreamPhase's caller contract).
    const kind = this.kindOf(sessionId) ?? 'claude'
    const nextSemantic = foldSemanticEvent(state.semantic, record, kind)
    const nextPhase = reduceStreamPhase(
      state.transcript.phase,
      record,
      nextSemantic.currentTurn,
    )

    const semanticChanged = nextSemantic !== state.semantic
    const t = state.transcript
    const phaseChanged =
      nextPhase.streamPhase !== t.phase.streamPhase ||
      nextPhase.streamPhasePendingToolName !== t.phase.streamPhasePendingToolName ||
      nextPhase.streamPhasePendingToolUseId !== t.phase.streamPhasePendingToolUseId ||
      nextPhase.turnStartedAt !== t.phase.turnStartedAt
    if (!semanticChanged && !phaseChanged) return

    state.semantic = nextSemantic
    this.mutate(sessionId, prev => ({
      ...prev,
      semanticTurn: nextSemantic.currentTurn,
      semanticHistory: nextSemantic.history,
      semantic: nextSemantic,
      phase: nextPhase,
    }))
  }

  private mutate(
    sessionId: string,
    update: (t: SessionTranscript) => SessionTranscript,
  ): void {
    const state = this.state(sessionId)
    state.transcript = update(state.transcript)
    const set = this.listeners.get(sessionId)
    if (set) for (const cb of [...set]) cb()
  }
}
