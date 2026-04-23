import { useEffect } from 'react'

import type { Entry } from '@shared/types/transcript'
import {
  isCompactBoundaryEntry,
  isCompactSummaryEntry,
  isConversationEntry,
} from '@shared/types/transcript'
import { detectCodexApproval } from '@shared/parsers/codexScreen'
import { emptyRuntime, type SessionRuntime } from '@renderer/workspace/workspaceState'
import { appendFeedDebugLog, type FeedDebugInput } from '@renderer/workspace/runtime/feedDebug'
import type { SessionId } from '@renderer/workspace/types'
import {
  isSemanticTurnRunning,
  withDerivedSessionStatus,
} from '@renderer/workspace/semantic/helpers'
import { foldSemanticEvent } from '@renderer/workspace/semantic/foldEvent'
import { summarizeSemanticEventForDebug } from '@renderer/workspace/semantic/summarize'
import {
  extractCodexProviderSessionId,
  isCodexRolloutEntry,
  isOptimisticCodexUserEntry,
} from '@renderer/workspace/codex/entries'
import {
  codexHistoryMarker,
  codexTurnIdFromRollout,
  mapCodexRolloutToFeedEntries,
  stampCodexTurnId,
} from '@renderer/workspace/codex/rollout'
import {
  claudeHistoryMarker,
  extractEmbeddedClaudeProgressEntry,
} from '@renderer/workspace/claude/history'
import {
  entryTextContent,
  indexEntryIntoMaps,
  summarizeEntryForDebug,
} from '@renderer/workspace/entries/utils'
import { pickerEqual } from '@renderer/workspace/layout/helpers'
import {
  ghostsFromSemanticTurn,
  ghostsToPersist,
  reconcileUpstream,
} from '@renderer/workspace/ghosts'
import type { StreamPhase } from '@renderer/workspace/workspaceState'

import type {
  WorkspaceSetRuntimes,
  WorkspaceSetState,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

// -----------------------------------------------------------------------------
// useIpcSubscriptions — the one big side-effect that wires every
// window.api.onSession* listener.
//
// One listener per event type. The callback looks up the session by
// sessionId from the payload and patches the corresponding runtime.
// Deliberately a single effect so cleanup is one atomic teardown
// (required for HMR / StrictMode compatibility).
//
// Handlers intentionally stay inline here rather than broken into
// one-per-event files because they share refs, setters, and
// bookkeeping state (seenUuidsRef, latestScreenRef, bootstrapTimersRef)
// — breaking them apart would mean passing the whole ctx into each,
// gaining nothing but file count. If a handler ever grows to >200
// lines AND has no cross-handler state, it's a candidate for
// further extraction.
// -----------------------------------------------------------------------------

export function useIpcSubscriptions(
  refs: WorkspaceRefs,
  setState: WorkspaceSetState,
  setRuntimes: WorkspaceSetRuntimes,
  updateRuntime: (sessionId: SessionId, patch: Partial<SessionRuntime>) => void,
  appendFeedDebug: (sessionId: SessionId, input: FeedDebugInput) => void,
): void {
  useEffect(() => {
    const offStarted = window.api.onSessionStarted(({ sessionId, projectDir }) => {
      updateRuntime(sessionId, { projectDir })
      appendFeedDebug(sessionId, {
        layer: 'STATE',
        kind: 'session_started',
        summary: `session started${projectDir ? ` · ${projectDir}` : ''}`,
        data: { projectDir },
      })
    })

    const offScreen = window.api.onSessionScreen(
      ({ sessionId, plain, markdown, recent, recentMarkdown, picker }) => {
        // latestScreenRef is the synchronous source of truth for
        // the Enter-baseline capture in TileLeaf — always update
        // it, even when we bail on React state below.
        // Use `recent` (wider window) so the baseline includes any
        // assistant text that may have already scrolled out of the
        // viewport. The baseline comparison is the basis for "is
        // the streaming card stale?", which depends on seeing the
        // same marker the streaming extractor will see.
        refs.latestScreenRef.current[sessionId] = recent

        setRuntimes(prev => {
          const current = prev[sessionId] ?? emptyRuntime()
          // Screen snapshots fire continuously (CC redraws its TUI
          // at ~60Hz) but the actual text is usually identical
          // between frames — CC is redrawing chrome, cursor, or a
          // spinner that our parser already strips. Without a
          // bail-out, every idle frame triggers a new `runtimes`
          // state → useWorkspace re-render → TileTree/TileLeaf
          // reconcile → Feed.memo check (which does then skip, but
          // reconciliation to that point isn't free). Comparing
          // strings by reference first, then by value, and bailing
          // before setState entirely saves that whole pass on
          // every no-op frame. This is the difference between
          // "scheduled work on every frame" and "scheduled work
          // only when the screen actually changed".
          if (
            current.screen === plain &&
            current.screenMarkdown === markdown &&
            current.recentScreen === recent &&
            current.recentScreenMarkdown === recentMarkdown &&
            pickerEqual(current.picker, picker)
          ) {
            return prev
          }
          const changed: string[] = []
          if (current.screen !== plain) changed.push('screen')
          if (current.recentScreen !== recent) changed.push('recent')
          if (current.screenMarkdown !== markdown) changed.push('markdown')
          if (!pickerEqual(current.picker, picker)) changed.push('picker')
          // Detect Codex approval overlay from the screen. Only
          // runs for codex sessions — Claude has its own trust
          // dialog path.
          //
          // Two sources feed `pendingApproval`:
          //   1. JSONL `exec_approval_request` — authoritative for
          //      `callId` / `command` / `workdir`. The callId is
          //      what we match against `exec_command_end` to
          //      dismiss.
          //   2. Screen scrape — authoritative for the dynamic UI
          //      bits the user actually sees (`reason`, `options`,
          //      `selectedIndex`) since arrow-key nav only updates
          //      the TUI, never the JSONL.
          //
          // Originally this handler clobbered the JSONL fields
          // with `callId: null`, which broke dismissal: when
          // `exec_command_end` arrived later, the comparison
          // `current.pendingApproval?.callId === resolvedCallId`
          // saw `null === "real-id"` and the modal stuck forever.
          // Now we MERGE — JSONL fields survive screen frames;
          // screen fields overwrite their counterparts on every
          // frame.
          //
          // When the screen shows no overlay we PRESERVE a
          // JSONL-sourced approval (callId !== null) — the rule is
          // "JSONL opens it, JSONL closes it". A screen-only
          // approval (callId === null) can be cleared by a stale
          // frame because there's no JSONL dismissal event coming.
          const sessionKind = refs.stateRef.current.sessions[sessionId]?.kind
          const screenApproval = sessionKind === 'codex'
            ? detectCodexApproval(plain)
            : null
          const nextApproval = screenApproval
            ? current.pendingApproval?.callId
              ? {
                  ...current.pendingApproval,
                  reason: screenApproval.reason,
                  options: screenApproval.options,
                  selectedIndex: screenApproval.selectedIndex,
                }
              : {
                  callId: null,
                  command: screenApproval.command
                    ? screenApproval.command.split(/\s+/)
                    : [],
                  workdir: null,
                  reason: screenApproval.reason,
                  options: screenApproval.options,
                  selectedIndex: screenApproval.selectedIndex,
                }
            : current.pendingApproval?.callId
              ? current.pendingApproval
              : null

          // Screen frames can differ only by transient TUI chrome
          // (cursor blink, spinner tick, timestamp) while the
          // visible transcript is unchanged. We still commit the
          // latest strings so DebugPanel/ReaderView stay faithful,
          // but skip the debug-log append for this shape of frame
          // to keep feed-debug readable.
          const chromeTickOnly =
            changed.every(k => k === 'screen' || k === 'recent' || k === 'markdown') &&
            changed.length > 0 &&
            recent.length === current.recentScreen.length &&
            pickerEqual(current.picker, picker) &&
            nextApproval === current.pendingApproval

          const nextBody = {
            ...current,
            screen: plain,
            screenMarkdown: markdown,
            recentScreen: recent,
            recentScreenMarkdown: recentMarkdown,
            picker,
            // activityStatus is owned by the process-state IPC
            // handler below — it carries the provider-correct verb
            // (Claude's spinner verb, Codex's bottom-row text).
            // Recomputing it here from `detectActivity(plain)` was
            // Claude-specific and would overwrite Codex's status
            // with null on every frame, racing the process-state
            // writer.
            pendingApproval: nextApproval,
          }
          const nextCurrent = chromeTickOnly
            ? nextBody
            : appendFeedDebugLog(
                nextBody,
                {
                  layer: 'STATE',
                  kind: 'screen_update',
                  summary: `screen update · ${changed.join(', ')}`,
                  data: {
                    changed,
                    pickerVisible: picker.visible,
                    pickerCount: picker.items.length,
                    approvalOpen: nextApproval !== null,
                    recentLength: recent.length,
                  },
                },
              )
          return {
            ...prev,
            [sessionId]: nextCurrent,
          }
        })
      },
    )

    // The singular session:jsonl-entry IPC handler used to live
    // here. It owned: codex providerSessionId capture, codex
    // approval request/resolve, claude queue-operation
    // bookkeeping, claude providerSessionId capture,
    // pendingCompaction clearing, and the entry append itself.
    //
    // It caused the bootstrap-replay cascade. On a resume Claude /
    // Codex emits ~200 jsonl-entry events synchronously; main used
    // to dual-emit those as 200 separate session:jsonl-entry IPC
    // sends PLUS one coalesced session:jsonl-entries burst. The
    // 200 singular messages always reached the renderer first
    // (they were enqueued first), and the singular handler did 200
    // separate setRuntimes calls — one full re-render per entry,
    // plus the auto-scroll pin and lazy-mount cascade per entry.
    // By the time the bulk message arrived, every uuid was already
    // in seenUuidsRef and the bulk path no-op'd — the bootstrapping
    // flag never asserted.
    //
    // The fix: drop the singular IPC emit on main entirely (see
    // main/sessions/forwarder.ts); make the bulk handler below own
    // every side-effect that used to live here. Live single
    // entries arrive as 1-element bursts with ~1ms setImmediate
    // latency.
    //
    // If you need to re-introduce a single-entry consumer, route
    // it through the bulk channel as a 1-element burst. Do NOT add
    // a second IPC channel that races the bulk one.

    const offErr = window.api.onSessionJsonlError(({ sessionId, message }) => {
      // eslint-disable-next-line no-console
      console.warn(`[jsonl ${sessionId.slice(0, 8)}]`, message)
    })

    const offExit = window.api.onSessionExit(({ sessionId, exitCode }) => {
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        const next = withDerivedSessionStatus(
          appendFeedDebugLog(
            {
              ...current,
              exited: exitCode,
              awaitingAssistant: false,
              queuedMessages: [],
              activityStatus: null,
              processActive: false,
              // Clear phase on exit. The WorkIndicator renders
              // nothing for `idle`; letting a pre-exit phase
              // linger would leave the in-feed indicator saying
              // e.g. "Awaiting Bash" on a dead session. Matching
              // the existing activityStatus null.
              streamPhase: 'idle',
              streamPhasePendingToolName: null,
              streamPhasePendingToolUseId: null,
              turnStartedAt: null,
              phaseChangedAt: null,
              submittedAt: null,
              semantic: {
                ...current.semantic,
                currentTurn: null,
              },
            },
            {
              layer: 'STATE',
              kind: 'session_exit',
              summary: `session exited code=${exitCode}`,
              data: { exitCode },
            },
          ),
        )
        return { ...prev, [sessionId]: next }
      })
    })

    // Provider-emitted activity state. Both providers now derive
    // this from their own screen spinner detector — Claude's
    // rotating-glyph line, Codex's bottom "Working (...)" row —
    // and forward the verb/status string alongside the boolean.
    // When status arrives we adopt it directly; the renderer used
    // to redundantly run Claude's detectActivity on every screen
    // frame to derive the verb, which was both wasteful and wrong
    // for Codex (the parser is Claude-specific). On idle
    // transitions, status is undefined and we clear activityStatus
    // too.
    const offProcessState = window.api.onSessionProcessState(
      ({ sessionId, active, status }) => {
        setRuntimes(prev => {
          const current = prev[sessionId] ?? emptyRuntime()
          const next = withDerivedSessionStatus(
            appendFeedDebugLog(
              {
                ...current,
                processActive: active,
                activityStatus: active ? (status ?? null) : null,
                awaitingAssistant: false,
              },
              {
                layer: 'STATE',
                kind: 'process_state',
                summary: active
                  ? `process active${status ? ` · ${status}` : ''}`
                  : 'process idle',
                data: { active, status: status ?? null },
              },
            ),
          )
          return { ...prev, [sessionId]: next }
        })
      },
    )

    const offSemantic = window.api.onSessionSemanticEvent(({ sessionId, event }) => {
      const semanticEvent = event as Record<string, unknown>
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        // WHY `?? 'claude'` default: Claude is the pre-fix
        // behavior (auto-replace / self-heal on turnId mismatch).
        // Falling back to the looser behavior during a
        // teardown-race where the session meta is momentarily
        // absent avoids silently dropping events we'd actually
        // want to keep. See
        // docs/superpowers/plans/2026-04-17-claude-semantic-provider-gating.md.
        const sessionKind = refs.stateRef.current.sessions[sessionId]?.kind ?? 'claude'
        const nextSemantic = foldSemanticEvent(current.semantic, semanticEvent, sessionKind)
        const eventType = typeof semanticEvent.type === 'string' ? semanticEvent.type : ''
        const clearOptimisticAwaiting =
          isSemanticTurnRunning(nextSemantic.currentTurn) ||
          eventType === 'turn_completed' ||
          eventType === 'turn_stopped' ||
          eventType === 'api_error' ||
          eventType === 'stream_error'

        // stream_phase — in-feed indicator state. Overrides the
        // optimistic `submitting` pseudo-phase once the adapter's
        // first real event lands. Handled inline here (not inside
        // foldSemanticEvent) because the field lives on
        // SessionRuntime, not SemanticRuntimeState; the fold would
        // be a layering violation.
        let streamPhase = current.streamPhase
        let streamPhasePendingToolName = current.streamPhasePendingToolName
        let streamPhasePendingToolUseId = current.streamPhasePendingToolUseId
        let turnStartedAt = current.turnStartedAt
        let phaseChangedAt = current.phaseChangedAt
        let submittedAt = current.submittedAt

        if (eventType === 'stream_phase') {
          const rawPhase =
            typeof semanticEvent.phase === 'string' ? semanticEvent.phase : 'idle'
          const nextPhase = rawPhase as StreamPhase
          if (nextPhase !== streamPhase) {
            const now = Date.now()
            streamPhase = nextPhase
            streamPhasePendingToolName =
              typeof semanticEvent.toolName === 'string'
                ? (semanticEvent.toolName as string)
                : null
            streamPhasePendingToolUseId =
              typeof semanticEvent.toolUseId === 'string'
                ? (semanticEvent.toolUseId as string)
                : null
            phaseChangedAt = now
            if (nextPhase === 'idle') {
              turnStartedAt = null
              submittedAt = null
            } else if (turnStartedAt === null) {
              // First non-idle phase of this turn — stamp the
              // start time. If the optimistic-submit path already
              // stamped `submittedAt`, prefer it over `now` so the
              // elapsed counter includes the gap between submit
              // and first adapter event.
              turnStartedAt = submittedAt ?? now
            }
          } else if (
            // Re-assign pending tool info even on same-phase
            // re-emit (turnId upgrade: null → real id is the
            // classic case).
            streamPhase !== 'idle'
          ) {
            streamPhasePendingToolName =
              typeof semanticEvent.toolName === 'string'
                ? (semanticEvent.toolName as string)
                : streamPhasePendingToolName
            streamPhasePendingToolUseId =
              typeof semanticEvent.toolUseId === 'string'
                ? (semanticEvent.toolUseId as string)
                : streamPhasePendingToolUseId
          }
        } else if (eventType === 'tool_result') {
          // Tool result arrived. If it matches the pending tool
          // we're `awaiting-tool` on, move to a neutral
          // 'requesting' phase so the indicator doesn't sit amber
          // after the tool returned. The adapter's next
          // stream_phase event (from the next assistant flow's
          // message_start) will overwrite; this is the
          // gap-filler.
          const resultToolUseId =
            typeof semanticEvent.toolUseId === 'string'
              ? (semanticEvent.toolUseId as string)
              : null
          if (
            streamPhase === 'awaiting-tool' &&
            resultToolUseId !== null &&
            resultToolUseId === streamPhasePendingToolUseId
          ) {
            streamPhase = 'requesting'
            streamPhasePendingToolName = null
            streamPhasePendingToolUseId = null
            phaseChangedAt = Date.now()
          }
        }

        // Ghost bridge — refresh the provisional ghost map from
        // the new semantic turn. This runs on every semantic tick;
        // `ghostsFromSemanticTurn` is idempotent and
        // reference-stable so no-op ticks (e.g. usage_updated
        // events) do not churn the map.
        //
        // WHY here and not inside `foldSemanticEvent`:
        //   foldSemanticEvent is intentionally agnostic to
        //   SessionRuntime — it reduces the SemanticRuntimeState
        //   sub-slice and knows nothing about sessionId or the
        //   outer runtime. The ghost map lives on SessionRuntime
        //   because it needs to survive across semantic history
        //   archival (when `currentTurn` flips to null) and because
        //   Phase 2 will persist it to disk with session-scoped
        //   file names. Calling the ghost reducer at this outer
        //   boundary keeps the layering clean.
        const nextGhosts = ghostsFromSemanticTurn(
          nextSemantic.currentTurn,
          sessionId,
          current.ghosts,
        )

        // Persist each changed ghost to disk (append-only JSONL
        // under <userData>/ghost-logs). Fire-and-forget from the
        // renderer; the main-side queue drains every 100 ms. See
        // `src/main/ghostJournal.ts` for the writer and
        // `../ghosts.ts` `ghostsToPersist` for why this diff is
        // safe.
        for (const ghost of ghostsToPersist(current.ghosts, nextGhosts)) {
          window.api.ghostAppend(sessionId, ghost)
        }

        // Full no-op short-circuit. foldSemanticEvent now returns
        // `state` unchanged for events that didn't mutate semantic
        // state; the ghost and phase paths are reference-stable
        // after the 2026-04-20 fixes. If all six signals agree
        // this event changed nothing and we're not clearing an
        // optimistic wait, bail out before appendFeedDebugLog to
        // avoid the SEM log noise bootstrap tool_results produced
        // in the evidence timeline (id:1-8). See 2026-04-20
        // rendering-fixes Task 8.
        const semanticUnchanged = nextSemantic === current.semantic
        const phaseUnchanged =
          streamPhase === current.streamPhase &&
          streamPhasePendingToolName === current.streamPhasePendingToolName &&
          streamPhasePendingToolUseId === current.streamPhasePendingToolUseId &&
          turnStartedAt === current.turnStartedAt &&
          phaseChangedAt === current.phaseChangedAt &&
          submittedAt === current.submittedAt
        const ghostsUnchanged = nextGhosts === current.ghosts
        const awaitingUnchanged = clearOptimisticAwaiting
          ? current.awaitingAssistant === false
          : true
        if (semanticUnchanged && phaseUnchanged && ghostsUnchanged && awaitingUnchanged) {
          return prev
        }

        const nextCurrent = withDerivedSessionStatus(
          appendFeedDebugLog(
            {
              ...current,
              awaitingAssistant: clearOptimisticAwaiting ? false : current.awaitingAssistant,
              semantic: nextSemantic,
              streamPhase,
              streamPhasePendingToolName,
              streamPhasePendingToolUseId,
              turnStartedAt,
              phaseChangedAt,
              submittedAt,
              ghosts: nextGhosts,
            },
            {
              layer: 'SEM',
              kind: eventType || 'semantic',
              summary: summarizeSemanticEventForDebug(semanticEvent),
              data: semanticEvent,
            },
          ),
        )
        return {
          ...prev,
          [sessionId]: nextCurrent,
        }
      })
    })

    const offTrustDialog = window.api.onSessionTrustDialog(
      ({ sessionId, visible, workspace }) => {
        updateRuntime(sessionId, {
          pendingTrustDialog: visible ? { workspace } : null,
        })
      },
    )

    const offResumePrompt = window.api.onSessionResumePrompt(({
      sessionId,
      visible,
      sessionAgeText,
      tokenCountText,
      options,
      selectedIndex,
    }) => {
      updateRuntime(sessionId, {
        pendingResumePrompt: visible
          ? { sessionAgeText, tokenCountText, options, selectedIndex }
          : null,
      })
    })

    const offCompactionState = window.api.onSessionCompactionState(({
      sessionId,
      visible,
      phase,
      statusText,
      errorText,
    }) => {
      updateRuntime(sessionId, {
        pendingCompaction: visible && phase
          ? { phase, statusText, errorText }
          : null,
      })
    })

    // Bulk jsonl-entry path — the ONLY entry handler now that main
    // no longer dual-emits singular events. Folds a whole burst in
    // one setRuntimes + at most one setState, grows the tool
    // indices incrementally, and sets `bootstrapping = true` for
    // the duration so Feed can suspend per-append auto-scroll +
    // lazy-mount cascades. See the deleted-handler comment above
    // and docs/superpowers/plans/2026-04-15-bootstrap-replay-perf.md
    // for the full rationale.
    //
    // Side-effects absorbed from the old singular handler:
    //   1. Codex providerSessionId capture (from session_meta).
    //   2. Codex approval request / resolve (per entry).
    //   3. Claude queue-operation bookkeeping (per entry).
    //   4. Claude providerSessionId capture (from any entry's sessionId).
    //   5. pendingCompaction clearing on compact summary entries.
    //   6. Optimistic-Codex-user reconciliation against the head row.
    const offEntries = window.api.onSessionJsonlEntries(({ sessionId, entries }) => {
      if (!entries || entries.length === 0) return

      // Two passes per burst:
      //   A — accumulate workspace-state captures (providerSessionId).
      //       Apply via ONE setState if anything changed.
      //   B — accumulate runtime mutations (entries, queue,
      //       approval, compaction). Apply via ONE setRuntimes.
      // Splitting them keeps workspace.json in sync with new
      // providerSessionId on the same tick the entries land,
      // without doing N setState calls during a 200-entry burst.

      // ---- Pass A: workspace-state captures ----
      let capturedClaudeId: string | null = null
      let capturedCodexId: string | null = null
      for (const { entry: raw } of entries) {
        if (isCodexRolloutEntry(raw)) {
          if (!capturedCodexId) {
            const id = extractCodexProviderSessionId(raw)
            if (id) capturedCodexId = id
          }
          continue
        }
        if (!capturedClaudeId) {
          const ccId = (raw as { sessionId?: string }).sessionId
          if (typeof ccId === 'string' && ccId.length > 0) {
            capturedClaudeId = ccId
          }
        }
      }
      if (capturedClaudeId || capturedCodexId) {
        setState(prev => {
          const meta = prev.sessions[sessionId]
          if (!meta) return prev
          if (meta.providerSessionId) return prev
          const id = capturedClaudeId ?? capturedCodexId
          if (!id) return prev
          return {
            ...prev,
            sessions: {
              ...prev.sessions,
              [sessionId]: { ...meta, providerSessionId: id },
            },
          }
        })
      }

      // ---- Pass B: runtime mutations ----
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        const seen = (refs.seenUuidsRef.current[sessionId] ??= new Set())
        const appended: Entry[] = []
        let oldestMarker: string | null = current.historyOldestMarker
        let pendingCompaction = current.pendingCompaction
        let pendingApproval = current.pendingApproval
        let queuedMessages = current.queuedMessages
        let awaitingAssistant = current.awaitingAssistant
        // Set when a Codex user entry mapped from rollout matches
        // the optimistic head row already in current.entries. We
        // can only resolve it after the loop because the optimistic
        // row could also live in `appended` if we're processing
        // multiple bursts.
        let dropOptimisticHead = false

        // Reuse the existing map references so downstream consumers
        // that hold them live (Feed contexts) keep working without
        // a re-subscribe. The runtime object itself gets a new
        // top-level reference below so React re-renders.
        const toolUseIndex = current.toolUseIndex
        const toolResultIndex = current.toolResultIndex

        // Rolling Codex turn id — updated when a `turn_context`
        // rollout entry arrives, then stamped onto every mapped
        // response_item in the same turn. Feeds reconcileUpstream's
        // Codex supersede branch. See codexTurnIdFromRollout for
        // the extraction rule and reconcileUpstream for the match.
        let codexCurrentTurnId: string | null = null

        for (const { entry: raw } of entries) {
          // ---- Codex rollout branch ----
          if (isCodexRolloutEntry(raw)) {
            const payload = raw.payload as Record<string, unknown> | undefined
            const turnContextId = codexTurnIdFromRollout(raw)
            if (turnContextId !== null) codexCurrentTurnId = turnContextId
            const mappedRaw = mapCodexRolloutToFeedEntries(raw)
            const mapped = mappedRaw.map(e => stampCodexTurnId(e, codexCurrentTurnId))
            const marker = mapped.length > 0 ? codexHistoryMarker(raw) : null
            if (marker && !oldestMarker) oldestMarker = marker

            // Codex exec_approval_request opens an approval pane;
            // exec_command_end with the same call_id closes it.
            if (raw.type === 'event_msg' && payload?.type === 'exec_approval_request') {
              pendingApproval = {
                callId: typeof payload.call_id === 'string' ? payload.call_id : null,
                command: Array.isArray(payload.command)
                  ? payload.command.filter(
                      (part): part is string => typeof part === 'string',
                    )
                  : [],
                workdir: typeof payload.workdir === 'string' ? payload.workdir : null,
                reason: pendingApproval?.reason,
                options: pendingApproval?.options,
                selectedIndex: pendingApproval?.selectedIndex,
              }
            } else if (
              raw.type === 'event_msg' &&
              payload?.type === 'exec_command_end' &&
              typeof payload.call_id === 'string' &&
              pendingApproval?.callId === payload.call_id
            ) {
              pendingApproval = null
            }

            // Optimistic-user reconciliation.
            //
            // The optimistic row is appended directly to
            // `current.entries` by addOptimisticCodexUserEntry on
            // submit. It stays there until either (a) the PTY write
            // failed (catch branch in useComposerKeybinds calls
            // removeOptimisticCodexUserEntry) or (b) the committed
            // user entry lands here and this block drops it.
            //
            // WHY two parallel checks, not an if/else:
            //
            // The old implementation gated the `current.entries`
            // check behind `appended.length === 0` — i.e. "if we
            // haven't appended anything yet in this burst, consider
            // the optimistic row as a candidate for removal."
            // That's wrong when Codex's rollout emits the
            // env_context `<environment_context>` message BEFORE
            // the real user message. The env_context is a
            // non-matching user entry that gets appended first;
            // when the real user message arrives next, the
            // `appended.length > 0` branch runs, finds
            // env_context on the appended tail (not optimistic),
            // and never touches `current.entries` at all. The
            // optimistic row survives — the top-of-feed
            // duplication visible in the 2026-04-23 Codex pane
            // screenshot.
            //
            // The fix is to run both checks independently. They
            // target different data (appended[] is this burst's
            // accumulator; current.entries is the pre-burst state),
            // so there's no logical conflict.
            const firstMapped = mapped[0]
            if (firstMapped?.type === 'user') {
              const mappedText = entryTextContent(firstMapped)
              // Check appended[] tail — if an earlier mapped entry
              // in THIS burst was optimistic-like, pop it. In
              // practice this fires only on hot-swap / synthetic
              // cases; the typical hit is the current.entries
              // check below.
              if (appended.length > 0) {
                const lastAppended = appended[appended.length - 1]
                if (
                  isOptimisticCodexUserEntry(lastAppended) &&
                  entryTextContent(lastAppended) === mappedText
                ) {
                  appended.pop()
                }
              }
              // Check current.entries tail — if the pre-burst tail
              // is an optimistic row whose text matches this
              // mapped user entry, schedule its removal.
              // Unconditional: the `if (appended.length > 0)` gate
              // above was the bug that let env_context entries
              // arriving before the real user message hide the
              // optimistic tail from reconciliation.
              const lastExisting = current.entries[current.entries.length - 1]
              if (
                isOptimisticCodexUserEntry(lastExisting) &&
                entryTextContent(lastExisting) === mappedText
              ) {
                dropOptimisticHead = true
              }
            }

            for (const e of mapped) {
              const u = (e as { uuid?: string }).uuid
              if (u) {
                if (seen.has(u)) continue
                seen.add(u)
              }
              appended.push(e)
              indexEntryIntoMaps(e, toolUseIndex, toolResultIndex)
            }
            continue
          }

          // ---- Claude queue-operation branch ----
          // queue-operation entries are CC's internal
          // message-queue bookkeeping (see
          // claude-code-src/utils/messageQueueManager.ts for the
          // emit sites). 'enqueue' / 'dequeue' / 'remove' — the
          // latter two are collapsed into "drop head" because we
          // don't have identity info to do better. Not pushed
          // into `entries` (would render as feed noise).
          const entryType = (raw as { type?: string }).type
          if (entryType === 'queue-operation') {
            const op = raw as {
              operation?: 'enqueue' | 'dequeue' | 'remove'
              content?: string
              timestamp?: string
            }
            if (op.operation === 'enqueue' && typeof op.content === 'string') {
              const ts = op.timestamp ?? String(Date.now())
              const already = queuedMessages.some(
                q => q.timestamp === ts && q.content === op.content,
              )
              if (!already) {
                queuedMessages = [
                  ...queuedMessages,
                  { content: op.content, timestamp: ts },
                ]
              }
            } else if (op.operation === 'dequeue' || op.operation === 'remove') {
              queuedMessages = queuedMessages.slice(1)
            }
            // Force the streaming flag on whenever the queue has
            // items so the streaming card doesn't disappear
            // between turns while CC is draining queued work.
            if (queuedMessages.length > 0) awaitingAssistant = true
            continue
          }

          // ---- Claude conversation entry branch ----
          const feedEntry =
            extractEmbeddedClaudeProgressEntry(raw as Record<string, unknown>) ??
            (raw as Entry)
          const marker = claudeHistoryMarker(raw as Record<string, unknown>)
          if (marker && !oldestMarker) oldestMarker = marker
          const uuid = (feedEntry as { uuid?: string }).uuid
          if (uuid) {
            if (seen.has(uuid)) continue
            seen.add(uuid)
          }
          if (
            !isConversationEntry(feedEntry) &&
            !isCompactBoundaryEntry(feedEntry) &&
            !isCompactSummaryEntry(feedEntry)
          ) {
            continue
          }
          if (isCompactSummaryEntry(feedEntry)) pendingCompaction = null
          appended.push(feedEntry)
          indexEntryIntoMaps(feedEntry, toolUseIndex, toolResultIndex)
        }

        const baseEntries = dropOptimisticHead
          ? current.entries.slice(0, -1)
          : current.entries

        // Ghost reconciliation — when authoritative entries land,
        // supersede any live ghost whose `(turnId, blockIndex)`
        // they replace. Runs per appended entry so ghost→real
        // handoff is synchronous with the entry becoming visible;
        // the ghost drops out of the merged view in the same
        // render as the real entry appears.
        //
        // `reconcileUpstream` is a no-op when there are no ghosts,
        // and returns the same-size Map when no ghost matched, so
        // this is cheap in the common case. Non-conversation
        // entries (system, compact_boundary) pass through
        // untouched.
        let nextGhosts = current.ghosts
        for (const entry of appended) {
          nextGhosts = reconcileUpstream(entry, nextGhosts)
        }

        // Persist supersede records. When an upstream entry
        // matched a ghost, `reconcileUpstream` produced a new ghost
        // snapshot with `supersededBy` set; appending that to disk
        // is how crash-recovered state knows "this ghost is no
        // longer live."
        for (const ghost of ghostsToPersist(current.ghosts, nextGhosts)) {
          window.api.ghostAppend(sessionId, ghost)
        }

        // Bail only when literally nothing changed. Approval,
        // queue, and compaction transitions can fire on bursts
        // that don't append any feed entries at all. Include ghost
        // reference equality in the no-change check:
        // reconcileUpstream preserves the same Map reference when
        // no ghost matched, so this only fires setRuntimes when
        // ghosts actually changed. Matches the treatment of
        // queuedMessages and the rest of this guard.
        const ghostsChanged = nextGhosts !== current.ghosts
        const noChange =
          appended.length === 0 &&
          !dropOptimisticHead &&
          pendingCompaction === current.pendingCompaction &&
          pendingApproval === current.pendingApproval &&
          queuedMessages === current.queuedMessages &&
          awaitingAssistant === current.awaitingAssistant &&
          !ghostsChanged
        if (noChange) return prev

        const nextRuntime = withDerivedSessionStatus(
          appendFeedDebugLog(
            {
              ...current,
              entries: appended.length > 0 || dropOptimisticHead
                ? [...baseEntries, ...appended]
                : current.entries,
              historyOldestMarker: oldestMarker,
              bootstrapping: true,
              pendingCompaction,
              pendingApproval,
              queuedMessages,
              awaitingAssistant,
              toolUseIndex,
              toolResultIndex,
              ghosts: nextGhosts,
            },
            {
              layer: 'JSONL',
              kind: 'jsonl_entries',
              summary:
                appended.length > 0 || dropOptimisticHead
                  ? `entries +${appended.length}${dropOptimisticHead ? ' · reconciled optimistic user' : ''}`
                  : 'jsonl side-effects only',
              data: {
                burstSize: entries.length,
                appendedCount: appended.length,
                droppedOptimisticHead: dropOptimisticHead,
                appended: appended.slice(-8).map(summarizeEntryForDebug),
                queuedMessages: queuedMessages.length,
                pendingApproval: pendingApproval
                  ? {
                      callId: pendingApproval.callId,
                      command: pendingApproval.command,
                    }
                  : null,
              },
            },
          ),
        )
        return {
          ...prev,
          [sessionId]: nextRuntime,
        }
      })

      // Schedule the bootstrap flip. Each burst resets the debounce
      // timer — the phase ends after ~150ms of quiet (long enough
      // to cover a laggy resume replay, short enough that the user
      // doesn't notice a deferred scroll pin).
      const existing = refs.bootstrapTimersRef.current.get(sessionId)
      if (existing) clearTimeout(existing)
      const timer = setTimeout(() => {
        refs.bootstrapTimersRef.current.delete(sessionId)
        setRuntimes(prev => {
          const current = prev[sessionId]
          if (!current || !current.bootstrapping) return prev
          return {
            ...prev,
            [sessionId]: appendFeedDebugLog(
              { ...current, bootstrapping: false },
              {
                layer: 'STATE',
                kind: 'bootstrap_complete',
                summary: 'bootstrap replay quiet window elapsed',
              },
            ),
          }
        })
      }, 150)
      refs.bootstrapTimersRef.current.set(sessionId, timer)
    })

    return () => {
      offStarted()
      offScreen()
      // No singular offEntry() — see the deleted-handler comment
      // above. The bulk path is the only one.
      offEntries()
      offErr()
      offProcessState()
      offSemantic()
      offTrustDialog()
      offResumePrompt()
      offCompactionState()
      offExit()
      for (const t of refs.bootstrapTimersRef.current.values()) clearTimeout(t)
      refs.bootstrapTimersRef.current.clear()
    }
  }, [appendFeedDebug, refs, setRuntimes, setState, updateRuntime])
}
