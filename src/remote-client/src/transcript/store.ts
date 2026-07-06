import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { foldSemanticEvent } from '@renderer/workspace/semantic/foldEvent'
import { hasPendingSemanticTools } from '@renderer/workspace/semantic/helpers'
import { indexEntryIntoMaps } from '@renderer/workspace/entries/utils'
import {
  emptySemanticRuntime,
  type SemanticLiveTurn,
  type SemanticRuntimeState,
  type StreamPhase,
} from '@renderer/workspace/workspaceState'
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
// foldSemanticEvent, the registry transcript mappers, indexEntryIntoMaps —
// so the phone's model can only diverge from the desktop's where this file
// visibly chooses to (skipped subsystems), never silently in shared logic.
//
// Ingest discipline (must mirror useIpcSubscriptions Pass B + the history
// actions exactly, or entries duplicate/misorder):
//   - ONE seen-uuid Set per session gates BOTH backfill and live entries.
//   - History PREPENDS, live APPENDS.
//   - The pagination anchor is the first kept entry's historyMarker.
//   - The codex mapper is STATEFUL (rolling turn cursor) — one mapper
//     instance per session, kept for the session's lifetime.
//   - `stream_phase` events are reduced OUTSIDE foldSemanticEvent, exactly
//     as the desktop does (the phase lives beside the semantic slice, not
//     inside it).

export type SessionTranscript = {
  entries: Entry[]
  semanticTurn: SemanticLiveTurn | null
  semanticHistory: SemanticLiveTurn[]
  streamPhase: StreamPhase
  streamPhasePendingToolName: string | null
  streamPhasePendingToolUseId: string | null
  turnStartedAt: number | null
  toolUseIndex: Map<string, ToolUseBlock>
  toolResultIndex: Map<string, ToolResultBlock>
  toolIndexVersion: number
  conditions: ProviderConditionSnapshot | null
  workingStatus: string | null
  exited: boolean
  hasOlderHistory: boolean
  loadingOlderHistory: boolean
  totalEntries: number
}

type SessionState = {
  transcript: SessionTranscript
  semantic: SemanticRuntimeState
  seen: Set<string>
  mapper: ReturnType<
    ReturnType<typeof getRendererProviderCapabilities>['createTranscriptEntryMapper']
  > | null
  kind: AgentProviderKind | null
  historyOldestMarker: string | null
  historyLoaded: boolean
}

function emptyTranscript(): SessionTranscript {
  return {
    entries: [],
    semanticTurn: null,
    semanticHistory: [],
    streamPhase: 'idle',
    streamPhasePendingToolName: null,
    streamPhasePendingToolUseId: null,
    turnStartedAt: null,
    toolUseIndex: new Map(),
    toolResultIndex: new Map(),
    toolIndexVersion: 0,
    conditions: null,
    workingStatus: null,
    exited: false,
    hasOlderHistory: false,
    loadingOlderHistory: false,
    totalEntries: 0,
  }
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key]
  return typeof value === 'string' ? value : null
}

export class TranscriptStore {
  private readonly sessions = new Map<string, SessionState>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly unsubs: Array<() => void> = []

  constructor(private readonly feed: WebSocketSessionFeed) {
    this.unsubs.push(
      feed.onSessionJsonlEntries(e => {
        this.ingestRawEntries(e.sessionId, e.entries.map(x => x.entry as Record<string, unknown>), 'append')
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
      feed.onSessionExit(e => {
        // Mirror the desktop's exit boundary: dead processes own no live
        // turn, no phase, no prompts (useIpcSubscriptions offExit).
        const state = this.state(e.sessionId)
        state.semantic = { ...state.semantic, currentTurn: null }
        this.mutate(e.sessionId, t => ({
          ...t,
          exited: true,
          workingStatus: null,
          streamPhase: 'idle',
          streamPhasePendingToolName: null,
          streamPhasePendingToolUseId: null,
          turnStartedAt: null,
          semanticTurn: null,
          conditions: null,
        }))
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

  // --- backfill ---

  /** Load the initial newest-N chunk once per session. Prepends behind any
   *  live entries that already arrived — the shared seen-set makes the
   *  overlap safe, exactly like the desktop's initialHistory action. */
  async loadInitialHistory(sessionId: string): Promise<void> {
    const state = this.state(sessionId)
    if (state.historyLoaded) return
    state.historyLoaded = true
    this.mutate(sessionId, t => ({ ...t, loadingOlderHistory: true }))
    const result = await this.feed.getHistory(sessionId, { limit: 120 })
    if (!result.ok) {
      // "No transcript yet" is normal for a brand-new session — live frames
      // will populate the feed; allow a later retry once entries exist.
      state.historyLoaded = false
      this.mutate(sessionId, t => ({ ...t, loadingOlderHistory: false }))
      return
    }
    this.ingestRawEntries(sessionId, result.chunk.entries, 'prepend')
    this.mutate(sessionId, t => ({
      ...t,
      loadingOlderHistory: false,
      hasOlderHistory: result.chunk.hasMore,
      totalEntries: result.chunk.totalEntries ?? t.entries.length,
    }))
  }

  async loadOlderHistory(sessionId: string): Promise<void> {
    const state = this.state(sessionId)
    if (state.transcript.loadingOlderHistory || !state.transcript.hasOlderHistory) return
    const beforeMarker = state.historyOldestMarker
    if (!beforeMarker) return
    this.mutate(sessionId, t => ({ ...t, loadingOlderHistory: true }))
    const result = await this.feed.getHistory(sessionId, { beforeMarker, limit: 200 })
    if (!result.ok) {
      this.mutate(sessionId, t => ({ ...t, loadingOlderHistory: false }))
      return
    }
    this.ingestRawEntries(sessionId, result.chunk.entries, 'prepend')
    this.mutate(sessionId, t => ({
      ...t,
      loadingOlderHistory: false,
      // hasMore from the chunk is authoritative — an all-duplicate page
      // must NOT re-enable loading (same invariant as the desktop's
      // history action documents).
      hasOlderHistory: result.chunk.hasMore,
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
        mapper: null,
        kind: null,
        historyOldestMarker: null,
        historyLoaded: false,
      }
      this.sessions.set(sessionId, state)
    }
    return state
  }

  private kindOf(sessionId: string): AgentProviderKind {
    const state = this.state(sessionId)
    if (state.kind) return state.kind
    const listed = this.feed.getSessionList().find(s => s.sessionId === sessionId)?.kind
    if (listed && isAgentProviderKind(listed)) {
      state.kind = listed
      return listed
    }
    // Claude is the historical default across the app (DEFAULT_PROVIDER);
    // a wrong guess only mis-maps until the session list lands, which the
    // server sends before any session event on every connect.
    return 'claude'
  }

  private mapperOf(sessionId: string): NonNullable<SessionState['mapper']> {
    const state = this.state(sessionId)
    if (!state.mapper) {
      // ONE mapper per session for its whole lifetime — the codex mapper's
      // rolling turn cursor must survive across bursts (the desktop keeps
      // it in codexCurrentTurnIdBySession for the same reason).
      state.mapper = getRendererProviderCapabilities(this.kindOf(sessionId))
        .createTranscriptEntryMapper()
    }
    return state.mapper
  }

  private ingestRawEntries(
    sessionId: string,
    raws: Array<Record<string, unknown>>,
    mode: 'append' | 'prepend',
  ): void {
    if (raws.length === 0) return
    const state = this.state(sessionId)
    const mapper = this.mapperOf(sessionId)

    const kept: Entry[] = []
    let firstKeptMarker: string | null = null
    let toolIndexChanged = false
    let lastTimestamp: number | null = null

    for (const raw of raws) {
      const mapped = mapper.map(raw)
      if (mode === 'prepend' && firstKeptMarker === null && mapped.historyMarker) {
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
        const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
        if (!Number.isNaN(ts)) lastTimestamp = Math.max(lastTimestamp ?? 0, ts)
      }
    }

    if (mode === 'prepend' && firstKeptMarker) {
      state.historyOldestMarker = firstKeptMarker
    }
    if (kept.length === 0 && !toolIndexChanged) return

    this.mutate(sessionId, t => ({
      ...t,
      entries:
        mode === 'append' ? [...t.entries, ...kept] : [...kept, ...t.entries],
      totalEntries: t.totalEntries + (mode === 'append' ? kept.length : 0),
      toolIndexVersion: toolIndexChanged ? t.toolIndexVersion + 1 : t.toolIndexVersion,
    }))
    void lastTimestamp // reserved for a future stall indicator; desktop feeds it to ghost gating we skip
  }

  private ingestSemanticEvent(sessionId: string, event: unknown): void {
    const state = this.state(sessionId)
    const record = asRecord(event)
    if (!record) return
    const eventType = typeof record.type === 'string' ? record.type : ''

    // --- the out-of-fold stream-phase machine, mirroring
    // useIpcSubscriptions.ts (stream_phase / tool_result gap-filler /
    // turn_started + turn_completed provider-neutral bridge). Kept apart
    // from foldSemanticEvent because the phase lives beside the semantic
    // slice on the desktop too — folding it in would diverge the models.
    const t = state.transcript
    let streamPhase = t.streamPhase
    let pendingToolName = t.streamPhasePendingToolName
    let pendingToolUseId = t.streamPhasePendingToolUseId
    let turnStartedAt = t.turnStartedAt

    if (eventType === 'stream_phase') {
      const nextPhase = (typeof record.phase === 'string' ? record.phase : 'idle') as StreamPhase
      if (nextPhase !== streamPhase) {
        streamPhase = nextPhase
        pendingToolName = stringField(record, 'toolName')
        pendingToolUseId = stringField(record, 'toolUseId')
        if (nextPhase === 'idle') turnStartedAt = null
        else if (turnStartedAt === null) turnStartedAt = Date.now()
      } else if (streamPhase !== 'idle') {
        pendingToolName = stringField(record, 'toolName') ?? pendingToolName
        pendingToolUseId = stringField(record, 'toolUseId') ?? pendingToolUseId
      }
    } else if (eventType === 'tool_result') {
      const resultToolUseId = stringField(record, 'toolUseId')
      if (
        streamPhase === 'awaiting-tool' &&
        resultToolUseId !== null &&
        resultToolUseId === pendingToolUseId
      ) {
        streamPhase = 'requesting'
        pendingToolName = null
        pendingToolUseId = null
      }
    } else if (eventType === 'turn_started') {
      if (streamPhase === 'submitting' || streamPhase === 'requesting' || streamPhase === 'idle') {
        streamPhase = 'responding'
        if (turnStartedAt === null) turnStartedAt = Date.now()
      }
    }

    const nextSemantic = foldSemanticEvent(state.semantic, record, this.kindOf(sessionId))

    if (eventType === 'turn_completed' || eventType === 'turn_stopped') {
      const pendingTool =
        streamPhase === 'awaiting-tool' ||
        (nextSemantic.currentTurn !== null && hasPendingSemanticTools(nextSemantic.currentTurn))
      if (!pendingTool && streamPhase !== 'idle') {
        streamPhase = 'idle'
        pendingToolName = null
        pendingToolUseId = null
        turnStartedAt = null
      }
    }

    const semanticChanged = nextSemantic !== state.semantic
    const phaseChanged =
      streamPhase !== t.streamPhase ||
      pendingToolName !== t.streamPhasePendingToolName ||
      pendingToolUseId !== t.streamPhasePendingToolUseId ||
      turnStartedAt !== t.turnStartedAt
    if (!semanticChanged && !phaseChanged) return

    state.semantic = nextSemantic
    this.mutate(sessionId, prev => ({
      ...prev,
      semanticTurn: nextSemantic.currentTurn,
      semanticHistory: nextSemantic.history,
      streamPhase,
      streamPhasePendingToolName: pendingToolName,
      streamPhasePendingToolUseId: pendingToolUseId,
      turnStartedAt,
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
