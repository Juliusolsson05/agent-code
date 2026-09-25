import { REMOTE_HISTORY_TOO_LARGE } from '@shared/remoteOutputLimits'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { stepLiveSemantic } from '@renderer/session-runtime/ingest/liveSemantic'
import { faultRecoveredByDiagnostic } from '@renderer/session-runtime/liveChannelRecovery'
import type { StreamPhaseState } from '@renderer/session-runtime/semantic/streamPhaseMachine'
import { historyMarkerOf, planLiveEntryTrim, OLDER_PREPEND_TRIM_GRACE_MS } from '@renderer/session-runtime/liveEntryWindow'
import {
  admitMappedEntries,
  isPaginationAnchor,
  latestCommittedTimestamp,
  reindexToolsAfterMerge,
  type CommittedAdmissionMode,
  type CommittedSeenLedger,
} from '@renderer/session-runtime/ingest/committedRecords'
import { placeHistoryEntries, type HistoryPlacement } from '@renderer/session-runtime/ingest/historyPlacement'
import { indexEntryIntoMaps } from '@renderer/session-runtime/entries'
import { emptySemanticRuntime } from '@renderer/session-runtime/state'
import {
  applyDecisionToWindow,
  decideHistoryBoundary,
  emptyHistoryWindow,
  isStaleHistoryChunk,
  type HistoryWindow,
} from '@renderer/session-runtime/historyBoundary'
import type { SemanticLiveTurn, SemanticRuntimeState } from '@renderer/session-runtime/state'
import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import type { AgentProviderKind } from '@shared/types/providerKind'
import type { Entry, ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import type { ProviderConditionSnapshot } from '@shared/types/providerConditions'
import type { SessionHistoryPage, SessionHistoryRequest, SubAgentState } from '@shared/sessionFeed/types'
import { asRecord } from '@shared/lib/asRecord'

import type { WebSocketSessionFeed } from '../WebSocketSessionFeed'

// The phone's per-session transcript model — the MINIMAL SessionRuntime
// that drives the desktop Feed (see the semantic-rendering design doc's
// "Client state model" for what is deliberately skipped and why: ghosts,
// optimistic echoes, queue attribution, worktree evidence).
//
// Since #1177 the ingest RULES are not mirrored here — they are called. The
// committed-record admission (dedupe, trimmed tombstones, marker stamping,
// tool indexing), the initial-history placement and the live semantic step
// live in session-runtime/ingest/, and the desktop's live burst, initial
// loader and older pager run the very same functions. Mirroring had drifted
// in visible ways (blind history prepend, a constant lastJsonlEntryAt, a
// different tool-index policy for history), each fixed on one side only. What
// remains in this file is phone STORAGE and phone LIFECYCLE:
//   - ONE seen-uuid Set and one tombstone Set per session, dying with the
//     view (the desktop keeps its tombstones in a module registry instead).
//   - LIVE entries flow through one session-lifetime mapper (the codex
//     rolling turn cursor must survive across bursts); HISTORY chunks each
//     get a FRESH chunk-scoped mapper (the codex mapper's documented
//     contract — feeding old records through the live mapper stamps them
//     with the live turn id and corrupts the cursor both directions).
//   - A transcript ROLL (/clear, resume onto a new provider session) is
//     detected by comparing the `file` riding live frames and history
//     chunks; state resets so the old conversation cannot pollute the new.
//   - View-scoped retention: only viewed sessions hold a transcript.

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
  /** Live sub-agent fleet under this session (v2 sub-agents channel).
   *  Null until the server has emitted one — Feed treats null and {} the
   *  same for rendering, but null keeps the transcript reference-stable
   *  for sessions that never spawn children. */
  subAgents: Record<string, SubAgentState> | null
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
  /** Why the live transcript channels last failed (jsonl-error), or null.
   *  Distinct from historyError (a backfill failure): a session can have a
   *  healthy loaded window AND a dead live channel, or vice versa. */
  statusError: string | null
  exited: boolean
  hasOlderHistory: boolean
  loadingOlderHistory: boolean
  /** True while the INITIAL history backfill burst is being applied —
   *  the phone-side mirror of the desktop's bootstrapping concept. Feed
   *  accepts a `bootstrapping` prop that suspends per-append auto-scroll
   *  and the lazy-mount cascade during bulk replay; without it, the
   *  initial 120-entry burst paints per-append and the IntersectionObserver
   *  cascade fires for rows about to be superseded — visible jank exactly
   *  when the user first opens a session. Older-page pagination (user-
   *  initiated, scroll-position-preserved) deliberately does NOT set it:
   *  bootstrapping is for replay bursts, not interactive paging. */
  bootstrapping: boolean
  totalEntries: number
  /** Producer time of the newest committed row this view admitted (see
   *  latestCommittedTimestamp). The ownership ledger's collapsed-running
   *  rule reads it; the phone handed the ledger a constant 0 until #1177, so
   *  that rule could never fire here. */
  lastJsonlEntryAt: number | null
}

type SessionState = {
  transcript: SessionTranscript
  semantic: SemanticRuntimeState
  seen: Set<string>
  // Tombstones contain identities only, never entry/tool bodies. Live replay
  // must not append trimmed old rows at the tail; explicit pagination may
  // reload them. Both sets die when the last view releases this session.
  trimmed: Set<string>
  olderPrependAt: number | null
  /** Session-lifetime mapper for LIVE entries only (codex cursor). Created
   *  lazily once the kind is KNOWN from the session list — memoizing a
   *  mapper built on a fallback guess would bake the wrong provider in for
   *  the session's lifetime (review finding). */
  liveMapper: Mapper | null
  kind: AgentProviderKind | null
  /** Durable transcript file identity, from live frames / history chunks.
   *  Disagreement between the two = the provider rolled the transcript. */
  transcriptFile: string | null
  /** History-boundary window identity (grok). Decisions come from the shared
   *  pure owner (session-runtime/historyBoundary.ts); this store only applies
   *  them — the desktop and replay apply the same ones. */
  historyWindow: HistoryWindow
  historyOldestMarker: string | null
  historyOldestOffset: number | undefined
  historyLoaded: boolean
  historyLoading: boolean
  awaitingSemanticStart: boolean
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
    subAgents: null,
    screenText: '',
    historyError: null,
    statusError: null,
    exited: false,
    hasOlderHistory: false,
    loadingOlderHistory: false,
    bootstrapping: false,
    totalEntries: 0,
    lastJsonlEntryAt: null,
  }
}

// Entry-scoped cursor metadata dies with the entry. A single raw provider line
// may yield multiple feed entries: they are one pagination unit and must never
// be split by a trim. Offset is available on history replies, not live frames.
const entryCursors = new WeakMap<Entry, { group: object; offset?: number }>()
const NO_GHOSTS: ReadonlyMap<string, never> = new Map<string, never>()

export class TranscriptStore {
  private readonly sessions = new Map<string, SessionState>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly unsubs: Array<() => void> = []

  constructor(private readonly feed: WebSocketSessionFeed, private readonly now = Date.now) {
    this.unsubs.push(
      feed.onConnectionState(connection => {
        if (connection !== 'closed') return
        // A reconnect can have missed MORE than one page. Prepending a fresh
        // tail to the old window would silently join two disconnected ranges.
        // Drop the window and backfill anew on the next server session-list;
        // older pages remain available through the durable cursor contract.
        for (const id of this.sessions.keys()) {
          this.resetTranscript(id)
          this.state(id).awaitingSemanticStart = true
        }
      }),
      feed.onSessionJsonlEntries(e => {
        this.ingestLiveEntries(e.sessionId, e.entries as Array<{ entry: unknown; file: string }>)
      }),
      feed.onSessionHistoryBoundary(e => {
        this.ingestHistoryBoundary(e.sessionId, e)
      }),
      feed.onSessionSemanticEvent(e => {
        this.ingestSemanticEvent(e.sessionId, e.event)
      }),
      feed.onSessionJsonlError(e => {
        // v2: the durable/live transcript channels FAILED — OpenCode's
        // provider_session_switched notice and SSE/SQLite failures ride
        // here. Previously the phone dropped these entirely and a session
        // just silently stopped updating; now the status surface shows why.
        // Kept raw (the message string): filtering benign variants is a
        // presentation decision that belongs to the UI, not the store.
        this.mutate(e.sessionId, t => ({ ...t, statusError: e.message }))
      }),
      feed.onSessionTranscriptDiagnostic(e => {
        // A live channel that came up late clears the fault it raised on the
        // error channel above — the desktop's rule, shared (#1177). Until the
        // phone consumed this channel, a recovered Pi bridge or OpenCode
        // Terminal server kept its failure (and reload advice) on screen
        // forever. Only a session the store already holds can carry a fault.
        const recovered = faultRecoveredByDiagnostic(e.diagnostic)
        if (!recovered) return
        if (!this.sessions.get(e.sessionId)?.transcript.statusError?.includes(recovered)) return
        this.mutate(e.sessionId, t => ({ ...t, statusError: null }))
      }),
      feed.onSessionConditions(e => {
        this.mutate(e.sessionId, t => ({ ...t, conditions: e.snapshot }))
      }),
      feed.onSessionSubAgents(e => {
        // v2: the parent's live sub-agent fleet. Reference-equality check in
        // the mutate keeps an unchanged map from repainting the feed — the
        // server re-emits the whole map on every member change.
        this.mutate(e.sessionId, t =>
          t.subAgents === e.subAgents ? t : { ...t, subAgents: e.subAgents },
        )
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
          // A dead process owns no live channel either; a session-switched
          // or channel-failure notice about it is stale by definition.
          statusError: null,
        }))
      }),
      // Eviction + backfill retry both key off the session list, which the
      // server re-sends on every (re)connect and patches on started/exit/
      // removed. Sessions gone from the list are GONE from the manager —
      // holding their entries/seen-sets/mappers forever was unbounded
      // growth (review finding).
      feed.onSessionList(sessions => {
        const live = new Set(sessions.map(s => s.sessionId))
        // WHY a list never touches listener sets, and evicts only UNVIEWED
        // state (#847): the handshake list is computed on the server at
        // connection time and can predate a session the client is already
        // viewing. Whether that list is parsed before or after the view
        // subscribed depends on TCP chunking of the upgrade response, so an
        // "authoritative" list was a race. Deleting the listener set severed
        // the mounted view from the store for good: the later `started`
        // patch found no state to backfill, and live entries were dropped as
        // unviewed. The retention guarantee from #805 only ever needed
        // unviewed sessions to hold nothing; a mounted view keeps what it
        // shows, and its own unsubscribe resets the transcript when it leaves.
        for (const sessionId of [...this.sessions.keys()]) {
          if (!live.has(sessionId) && !this.isViewed(sessionId)) {
            this.sessions.delete(sessionId)
          }
        }
        // Reconnect/retry hook: a backfill that failed while the socket was
        // down stays failed forever without this — SessionView only calls
        // loadInitialHistory once per mount (review finding). The list
        // frame doubles as the "connection is live again" signal. Iterate
        // the VIEWS, not existing states: a session subscribed before it
        // appeared in any list has no state yet and must still backfill the
        // moment the list names it.
        for (const [sessionId, set] of this.listeners) {
          if (set.size === 0 || !live.has(sessionId)) continue
          const state = this.state(sessionId)
          if (!state.historyLoaded && !state.historyLoading) {
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
    const state = this.sessions.get(sessionId)
    if (set.size === 0 && state) {
      // File identity observed while unviewed is only a hint. A provider may
      // have rolled without another forwarded entry; let the new backfill
      // establish identity unless a live frame in THIS view wins the race.
      state.transcriptFile = null
    }
    set.add(cb)
    return () => {
      set.delete(cb)
      if (set.size > 0 || this.listeners.get(sessionId) !== set) return
      this.listeners.delete(sessionId)
      // A session the manager forgot while it was on screen kept its state
      // only because a view held it (session-list frames evict unviewed state
      // alone, #847). The last view leaving is the moment that state has no
      // owner left, so drop it outright rather than parking an empty shell
      // until the next list frame happens to arrive.
      if (!this.feed.getSessionList().some(s => s.sessionId === sessionId)) {
        this.sessions.delete(sessionId)
        return
      }
      // Selecting another session/list screen is an ownership boundary, not
      // merely a render pause. Keeping the last snapshot would retain the
      // entire transcript through indexes, semantic folds and mapper state.
      const file = this.state(sessionId).transcriptFile
      this.resetTranscript(sessionId)
      this.state(sessionId).transcriptFile = file
      this.state(sessionId).awaitingSemanticStart = true
    }
  }

  getSnapshot(sessionId: string): SessionTranscript {
    return this.state(sessionId).transcript
  }

  /** Resolved provider kind (list-backed). Until the list lands it is the
   *  named DEFAULT_PROVIDER — the server sends the list before any session
   *  event on every connect, so that window is one frame, and the rows keep
   *  no state from it. Exposed so SessionView doesn't duplicate the lookup
   *  (review finding). */
  getKind(sessionId: string): AgentProviderKind {
    return this.kindOf(sessionId) ?? DEFAULT_PROVIDER
  }

  // --- backfill ---

  /** Load the initial newest-N chunk once per viewed window. Prepends behind any
   *  live entries that already arrived — the shared seen-set makes the
   *  overlap safe, exactly like the desktop's initialHistory action.
   *  Failure leaves the flags retryable; retries fire from the session-list
   *  hook above and from live-entry arrival. */
  async loadInitialHistory(sessionId: string): Promise<void> {
    if (!this.isViewed(sessionId)) return
    const state = this.state(sessionId)
    if (state.historyLoaded || state.historyLoading || state.transcript.historyError === REMOTE_HISTORY_TOO_LARGE) return
    state.historyLoading = true
    this.mutate(sessionId, t => ({ ...t, loadingOlderHistory: true, bootstrapping: true }))
    const result = await this.readHistory({ sessionId, limit: 120 })
    // Disconnect, transcript roll, removal or disposal may replace this state
    // while the network request is pending. Its reply has no authority over
    // the new window, even when it names the same transcript file.
    if (this.sessions.get(sessionId) !== state) return
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
        bootstrapping: false,
        historyError: benign ? null : result.error,
      }))
      return
    }
    if (this.chunkFileConflicts(state, result.chunk.file)) {
      // The server's transcript-file cache was stale (post-/clear window):
      // the chunk is the PREVIOUS conversation. Discard it; live frames own
      // the file identity and a later retry will read the right file.
      this.mutate(sessionId, t => ({ ...t, loadingOlderHistory: false, bootstrapping: false }))
      return
    }
    state.historyLoaded = true
    if (state.transcriptFile === null && typeof result.chunk.file === 'string') {
      state.transcriptFile = result.chunk.file
    }
    const ingested = this.ingestRawEntries(
      sessionId,
      result.chunk.entries as Array<Record<string, unknown>>,
      'tail',
      result.chunk.offsets,
    )
    // The cursor names the oldest entry the view holds (desktop #910 item
    // 3): it moves to the chunk's anchor only when the placement changed
    // which row is first. A chunk placed AFTER the window, or one that added
    // nothing, must leave it where live ingest and earlier pages put it.
    if (ingested.anchor && !ingested.keptWindowHead) {
      state.historyOldestMarker = ingested.anchor.marker
      state.historyOldestOffset = ingested.anchor.offset
    }
    this.mutate(sessionId, t => ({
      ...t,
      loadingOlderHistory: false,
      bootstrapping: false,
      historyError: null,
      // Desktop guard (history.ts): a chunk with more history but NO usable
      // marker cannot be paged — advertising the affordance would render a
      // permanently dead control.
      hasOlderHistory: result.chunk.hasMore && state.historyOldestMarker !== null,
      totalEntries: result.chunk.totalEntries ?? t.entries.length,
    }))
    this.trimLiveWindow(sessionId)
  }

  async loadOlderHistory(sessionId: string): Promise<void> {
    if (!this.isViewed(sessionId)) return
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
    const result = await this.readHistory({
      sessionId,
      beforeMarker,
      ...(state.historyOldestOffset === undefined ? {} : { beforeOffset: state.historyOldestOffset }),
      limit: 200,
    })
    if (this.sessions.get(sessionId) !== state) return
    if (!result.ok || this.chunkFileConflicts(state, result.chunk?.file)) {
      this.mutate(sessionId, t => ({
        ...t,
        loadingOlderHistory: false,
        historyError: result.ok ? t.historyError : result.error,
        hasOlderHistory: !result.ok && result.error === REMOTE_HISTORY_TOO_LARGE ? false : t.hasOlderHistory,
      }))
      return
    }
    state.olderPrependAt = this.now()
    const { anchor } = this.ingestRawEntries(
      sessionId,
      result.chunk.entries as Array<Record<string, unknown>>,
      'older',
      result.chunk.offsets,
    )
    if (anchor) {
      state.historyOldestMarker = anchor.marker
      state.historyOldestOffset = anchor.offset
    }
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

  /**
   * SessionFeed.loadHistory reports failure as a rejection (the contract's
   * shape on every transport); this store's backfill logic branches on the
   * failure TEXT (benign "no transcript yet", REMOTE_HISTORY_TOO_LARGE) and
   * on success/failure as data. Folding the rejection back into a result
   * here keeps that logic, and every guard written against it, unchanged by
   * the move onto the contract (#1177).
   */
  private async readHistory(
    request: SessionHistoryRequest,
  ): Promise<{ ok: true; chunk: SessionHistoryPage } | { ok: false; error: string }> {
    try {
      return { ok: true, chunk: await this.feed.loadHistory(request) }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  private state(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId)
    if (!state) {
      state = {
        transcript: emptyTranscript(),
        semantic: emptySemanticRuntime(),
        seen: new Set(),
        trimmed: new Set(),
        olderPrependAt: null,
        liveMapper: null,
        kind: null,
        transcriptFile: null,
        historyWindow: emptyHistoryWindow(),
        historyOldestMarker: null,
        historyOldestOffset: undefined,
        historyLoaded: false,
        historyLoading: false,
        awaitingSemanticStart: true,
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
    return getRendererProviderCapabilities(DEFAULT_PROVIDER).createTranscriptEntryMapper()
  }

  /** Fresh chunk-scoped mapper — the desktop's rule for history chunks
   *  (initialHistory.ts / history.ts both document it): the codex turn
   *  cursor must start null per chunk so old records never get stamped
   *  with the live turn id, and the live cursor never inherits a stale
   *  historical one. */
  private chunkMapper(sessionId: string): Mapper {
    const kind = this.kindOf(sessionId) ?? DEFAULT_PROVIDER
    return getRendererProviderCapabilities(kind).createTranscriptEntryMapper()
  }

  private chunkFileConflicts(state: SessionState, chunkFile: unknown): boolean {
    // The shared pure owner owns the decision (grok Stage 5): a stale chunk is
    // one that names a different file than the window, or an older generation
    // once a boundary established one. History chunks carry no generation
    // today, so that branch stays dormant until they do — same decision
    // either way, made once.
    if (typeof chunkFile !== 'string') return false
    return isStaleHistoryChunk(state.historyWindow, { file: chunkFile }) ||
      (state.transcriptFile !== null && chunkFile !== state.transcriptFile)
  }

  private ingestHistoryBoundary(
    sessionId: string,
    boundary: { type: 'reset' | 'caught-up'; generation: number; snapshotByteLength: number; byteOffset?: number; complete?: boolean; file: string },
  ): void {
    const state = this.state(sessionId)
    const decision = decideHistoryBoundary(state.historyWindow, boundary)
    state.historyWindow = applyDecisionToWindow(state.historyWindow, decision)
    if (decision.kind !== 'apply-reset') return
    // The reset itself reuses the existing transcript reset (which preserves
    // conditions, working status, screen and exit state — the shared preserve
    // list) and re-arms the awaiting-turn-start gate so suffixes from the
    // superseded generation cannot repaint the wiped window.
    this.resetTranscript(sessionId)
    this.state(sessionId).awaitingSemanticStart = true
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

    if (!this.isViewed(sessionId)) return

    const { anchor } = this.ingestRawEntries(
      sessionId,
      items.map(x => x.entry as Record<string, unknown>),
      'live',
    )
    // The desktop's live rule: a burst anchors pagination only while the
    // view has no cursor yet (a trim or a history load moves it after that).
    // Without it, a view whose first rows arrived live, and whose backfill
    // was then placed AFTER them (#910), had no cursor at all and could
    // never page back.
    const live = this.state(sessionId)
    if (live.historyOldestMarker === null && anchor) live.historyOldestMarker = anchor.marker

    // Live-entry arrival is also the backfill retry trigger for sessions
    // whose initial get-history failed with "no transcript on disk yet".
    const fresh = this.state(sessionId)
    if (!fresh.historyLoaded && !fresh.historyLoading && (this.listeners.get(sessionId)?.size ?? 0) > 0) {
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
        exited: prev.transcript.exited,
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
      // ordering, the turn's content still commits through the jsonl entries.
      // Semantic painting waits for a fresh turn_started (a suffix alone has
      // no authority after a reset). This trades a temporary
      // live-streaming gap versus guaranteed cross-conversation contamination
      // the other way.
      semantic: emptySemanticRuntime(),
      seen: new Set(),
      trimmed: new Set(),
      olderPrependAt: null,
      liveMapper: null,
      kind: prev.kind,
      transcriptFile: null,
      // The boundary window SURVIVES a transcript reset: the reset may be the
      // application of a boundary decision itself (ingestHistoryBoundary), and
      // wiping it would forget the generation we just armed against — a
      // re-delivered duplicate boundary would then re-reset, and a stale one
      // would pass. It also survives the heuristic file-roll reset for the
      // same reason: whatever roll happened, the window only ever moves
      // forward through the pure owner's decisions.
      historyWindow: prev.historyWindow,
      historyOldestMarker: null,
      historyOldestOffset: undefined,
      historyLoaded: false,
      historyLoading: false,
      awaitingSemanticStart: true,
    })
    const set = this.listeners.get(sessionId)
    if (set) for (const cb of [...set]) cb()
  }

  /**
   * Map + admit a batch of raw records under the SHARED committed-record rules
   * (session-runtime/ingest/committedRecords.ts, #1177) — the same dedupe,
   * marker stamping, tool indexing and placement the desktop's three ingest
   * sites run, so the phone can no longer drift from them. What stays here is
   * only phone storage: its tombstone Set, and the per-line cursor group that
   * keeps a trim from splitting one raw line's fanned-out entries.
   *
   * `tail` is the initial newest-N chunk: its entries are PLACED against the
   * live window by the #910 rule rather than blindly prepended (the phone
   * prepended until #1177 — a live burst that landed before the backfill, or
   * a durable read that trailed the live stream, put newer turns above older
   * ones, permanently, because their uuids were then seen). `older` is a page
   * strictly before the oldest marker, so a plain prepend is exact there.
   *
   * Returns the chunk's pagination anchor (first record that mapped to an
   * entry and carries a marker) and whether the window's first row is still
   * first — the desktop's #910 item 3 test for whether the cursor may move.
   */
  private ingestRawEntries(
    sessionId: string,
    raws: Array<Record<string, unknown>>,
    mode: CommittedAdmissionMode,
    offsets?: number[],
  ): { anchor: { marker: string; offset?: number } | null; keptWindowHead: boolean } {
    const state = this.state(sessionId)
    const before = state.transcript.entries
    if (raws.length === 0) return { anchor: null, keptWindowHead: before.length > 0 }
    const mapper = mode === 'live' ? this.liveMapperOf(sessionId) : this.chunkMapper(sessionId)
    const ledger: CommittedSeenLedger = {
      seen: state.seen,
      isTrimmed: uuid => state.trimmed.has(uuid),
      releaseTrimmed: uuid => { state.trimmed.delete(uuid) },
    }
    const indexes = { toolUseIndex: state.transcript.toolUseIndex, toolResultIndex: state.transcript.toolResultIndex }
    const placement: HistoryPlacement[] | undefined = mode === 'tail' ? [] : undefined

    const kept: Entry[] = []
    let anchor: { marker: string; offset?: number } | null = null
    let toolIndexChanged = false

    for (const [rawIndex, raw] of raws.entries()) {
      const mapped = mapper.map(raw)
      const cursor = { group: {}, offset: offsets?.[rawIndex] }
      if (anchor === null && isPaginationAnchor(mapped.entries, mapped.historyMarker)) {
        anchor = { marker: mapped.historyMarker, offset: cursor.offset }
      }
      // Only a live burst indexes as it admits (its rows are the newest, so
      // admission order is window order); history reindexes after merging.
      const admission = admitMappedEntries(mapped.entries, mapped.historyMarker, mode, ledger, {
        indexes: mode === 'live' ? indexes : undefined,
        placement,
      })
      for (const entry of admission.admitted) {
        entryCursors.set(entry, cursor)
        kept.push(entry)
      }
      if (admission.toolIndexChanged) toolIndexChanged = true
    }

    if (kept.length === 0 && !toolIndexChanged) return { anchor, keptWindowHead: before.length > 0 }

    let entries: Entry[]
    if (mode === 'live') {
      entries = [...before, ...kept]
    } else {
      entries = mode === 'tail' && kept.length > 0
        ? placeHistoryEntries(placement!, before).entries
        : [...kept, ...before]
      // Finish this before notifying subscribers: a snapshot's version must
      // never advertise indexes that still contain historical winners.
      if (reindexToolsAfterMerge(kept, entries, indexes)) toolIndexChanged = true
    }
    // Observed, as the desktop's placement reports it: is the window's first
    // row still first? That, not "did this batch add anything", decides
    // whether the pagination cursor may move.
    const keptWindowHead = before.length > 0 && entries[0] === before[0]
    this.mutate(sessionId, t => ({
      ...t,
      entries,
      totalEntries: t.totalEntries + (mode === 'live' ? kept.length : 0),
      toolIndexVersion: toolIndexChanged ? t.toolIndexVersion + 1 : t.toolIndexVersion,
      // Producer-time cursor of the newest COMMITTED row, the ledger's input
      // for the collapsed-running rule and the desktop's ghost gate. An older
      // page cannot move it forward, so only live and tail batches fold it.
      lastJsonlEntryAt: mode === 'older' ? t.lastJsonlEntryAt : latestCommittedTimestamp(t.lastJsonlEntryAt, kept),
    }))
    if (mode === 'live') this.trimLiveWindow(sessionId)
    return { anchor, keptWindowHead }
  }

  private isViewed(sessionId: string): boolean {
    return (this.listeners.get(sessionId)?.size ?? 0) > 0
  }

  private trimLiveWindow(sessionId: string): void {
    const state = this.state(sessionId)
    const t = state.transcript
    if (t.loadingOlderHistory) return
    if (state.olderPrependAt !== null && this.now() - state.olderPrependAt < OLDER_PREPEND_TRIM_GRACE_MS) return
    // Reuse only the desktop's pure safety policy. Remote has no ghosts and
    // must not register ids in desktop-global tombstone/grace registries.
    // Current/history semantic owners and cross-entry tool pairs can pin the
    // window above its target; losing ownership to hit a cap repaints copies.
    const plan = planLiveEntryTrim(t.entries, state.semantic, NO_GHOSTS)
    if (!plan) return
    const cut = plan.cut
    // A raw line can map to several entries (OpenCode tool fan-out). A cursor
    // addresses the whole line. Splitting it would make its trimmed children
    // unreachable; moving the cut ourselves could invalidate tool-pair safety.
    // Keep the window until a later burst permits a whole-record boundary.
    if (entryCursors.get(t.entries[cut - 1])?.group === entryCursors.get(t.entries[cut])?.group) return
    const marker = historyMarkerOf(t.entries[cut])
    if (!marker) return
    const entries = t.entries.slice(cut)
    for (const entry of t.entries.slice(0, cut)) state.trimmed.add(entry.uuid!)
    state.historyOldestMarker = marker
    state.historyOldestOffset = entryCursors.get(entries[0])?.offset
    // Slicing entries alone leaves tool-result bodies retained by the indexes.
    // Rebuild in chronological order so each id still resolves to its latest
    // retained block. The planner guarantees a retained result keeps its use.
    const toolUseIndex = new Map<string, ToolUseBlock>()
    const toolResultIndex = new Map<string, ToolResultBlock>()
    for (const entry of entries) indexEntryIntoMaps(entry, toolUseIndex, toolResultIndex)
    this.mutate(sessionId, prev => ({
      ...prev, entries, toolUseIndex, toolResultIndex,
      toolIndexVersion: prev.toolIndexVersion + 1,
      hasOlderHistory: true,
    }))
  }

  private ingestSemanticEvent(sessionId: string, event: unknown): void {
    if (!this.isViewed(sessionId)) return
    const state = this.state(sessionId)
    const record = asRecord(event)
    if (!record) return
    if (state.awaitingSemanticStart) {
      // We did not see the prefix of the interrupted semantic turn. Rendering
      // its suffix as a complete live answer is misleading. Durable JSONL
      // still flows; live semantic painting resumes at the next turn boundary.
      // A refusal is a complete request-status fact even when the reconnect
      // missed the assistant prefix. Keep waiting for a real turn_started for
      // prose, while admitting a no-turn API error into the shared notice fold.
      if (record.type !== 'turn_started' && record.type !== 'api_error') return
      if (record.type === 'turn_started') state.awaitingSemanticStart = false
    }

    // The desktop's own step (session-runtime/ingest/liveSemantic.ts): fold,
    // then the shared phase machine over the POST-fold turn, with
    // prompt_suggestion routed around both. The phone has no suggestion chip,
    // so an out-of-band event is simply dropped here.
    const kind = this.kindOf(sessionId) ?? DEFAULT_PROVIDER
    const step = stepLiveSemantic(state.semantic, state.transcript.phase, record, kind)
    if (step.kind === 'out-of-band') return
    const nextSemantic = step.semantic
    const nextPhase = step.phase

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
