import { useEffect } from 'react'

import type { Entry } from '@shared/types/transcript'
import {
  isCompactBoundaryEntry,
  isCompactSummaryEntry,
  isConversationEntry,
} from '@shared/types/transcript'
import { emptyRuntime, type SessionRuntime } from '@renderer/workspace/workspaceState'
import { appendFeedDebugLog, type FeedDebugInput } from '@renderer/workspace/runtime/feedDebug'
import type { SessionId } from '@renderer/workspace/types'
import {
  isSemanticTurnRunning,
  semanticHistoryRow,
  SEMANTIC_HISTORY_CAP,
  withDerivedSessionStatus,
} from '@renderer/workspace/semantic/helpers'
import { foldSemanticEvent } from '@renderer/workspace/semantic/foldEvent'
import { applyPromptSuggestionToRuntime } from '@renderer/workspace/hook/ipc/applyPromptSuggestionToRuntime'
import { summarizeSemanticEventForDebug } from '@renderer/workspace/semantic/summarize'
import { recordScreenTailSnapshot } from '@renderer/features/debug/renderTrace'
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
  codexEventType,
  codexTurnIdFromEventPayload,
} from '@renderer/workspace/codex/eventCursor'
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
  gcSupersededGhosts,
  ghostsFromSemanticTurn,
  ghostsToPersist,
  orphanStale,
  reconcileUpstream,
} from '@renderer/workspace/ghosts'
import {
  codexPromptsMatchForOwnership,
} from '@renderer/workspace/hook/actions/streaming'
import { shouldClearIdleCodexQueuedMessages } from '@renderer/workspace/queueInvariants'
import type { StreamPhase } from '@renderer/workspace/workspaceState'
import type { ProviderConditionSnapshot } from '@shared/types/providerConditions'
import type { WorktreeIdentity } from '@shared/work-context/types'
import {
  canonicalizeWorktreeActivity,
  deriveAgentWorkContext,
  ingestWorktreeRawEvent,
  withFallbackWorktreeActivity,
} from '@shared/work-context/tracker'
import { summarizeWorktreeActivity } from '@shared/work-context/debug'
import { asRecord } from '@shared/lib/asRecord'

import type {
  WorkspaceSetRuntimes,
  WorkspaceSetState,
} from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import * as perf from '@renderer/performance/client'

// Codex rollout is delivered as many small IPC bursts, but `turn_context`
// is only one line near the beginning of the task. The bundle that
// reproduced duplicate user rows had later `response_item` user/assistant
// messages arriving in their own bursts with no nearby `turn_context`, even
// though the raw payload still carried the same `turn_id`.
//
// Keep the rolling turn id outside the React runtime object because this is
// ingestion bookkeeping, not UI state. Rendering should react to stamped feed
// entries, not to the parser cursor we happened to need while reading JSONL.
// Terminal Codex events and session exit clear the cursor so a new task cannot
// inherit the previous task's turn id.
const codexCurrentTurnIdBySession = new Map<SessionId, string>()

function stringField(record: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = record?.[key]
  return typeof value === 'string' ? value : null
}

function entryUuid(entry: Entry): string | null {
  return typeof entry.uuid === 'string' ? entry.uuid : null
}

type WorktreeCacheEntry = {
  worktrees: WorktreeIdentity[]
  refreshedAt: number
  inflight: Promise<void> | null
}

const WORKTREE_CACHE_TTL_MS = 5000
const WORK_CONTEXT_RECENT_RAW_LIMIT = 500
// Threshold before an unsuperseded ghost is marked orphaned.
//
// History: 3000ms while orphan rendering was always-on (commit
// 686b94e), then 30000ms when the layered predicate landed.
//
// With the layered predicate in mergedEntries.ts, an orphan flag
// merely makes a ghost ELIGIBLE for rendering; rules 4 (timestamp
// gate) and 5 (sidecar shape) still gate final visibility, and
// rule 3 hides ghosts whose turn id is already owned by semantic
// current/history. So during healthy operation, even a tool that runs
// tens of seconds doesn't visibly orphan: the semantic reducer keeps
// `currentTurn` alive across pending tools (see
// hasPendingSemanticTools in semantic/helpers.ts), and archived
// semantic history continues to own completed turns while JSONL
// catches up. The TTL here is the failsafe boundary for "how long
// before we conclude JSONL had its chance" — reachable only
// when currentTurn has cleared and JSONL has genuinely stalled.
//
// 30000ms matches atp's library default and is the right balance:
// long enough that a normal slow operation doesn't trip it, short
// enough that a real stuck-mid-turn case surfaces within roughly
// half a minute on resume.
//
// Sweep cadence stays at 1s — that's the polling rate, not the
// threshold.
//
// See docs/design/ghost-system.md for the canonical explanation.
const GHOST_ORPHAN_TTL_MS = 30000
const GHOST_ORPHAN_SWEEP_MS = 1000
const GHOST_SUPERSEDED_GC_MS = 5000

function canIngestWorkContext(raw: unknown, hasWorktreeCache: boolean): boolean {
  const type = (raw as { type?: unknown })?.type
  return type === 'worktree-state' || hasWorktreeCache
}

function appendRecentWorkContextRaw(
  recentRawBySession: Map<SessionId, unknown[]>,
  sessionId: SessionId,
  entries: Array<{ entry: unknown }>,
): void {
  const current = recentRawBySession.get(sessionId) ?? []
  const next = current.concat(entries.map(({ entry }) => entry))
  recentRawBySession.set(
    sessionId,
    next.length > WORK_CONTEXT_RECENT_RAW_LIMIT
      ? next.slice(-WORK_CONTEXT_RECENT_RAW_LIMIT)
      : next,
  )
}

function applyConditionSnapshot(
  runtime: SessionRuntime,
  snapshot: ProviderConditionSnapshot,
): SessionRuntime {
  if (snapshot.provider === 'claude') {
    const trust = snapshot.conditions['claude.trust-dialog']?.state
    const resume = snapshot.conditions['claude.resume-prompt']?.state
    const permission = snapshot.conditions['claude.permission-prompt']?.state
    const compaction = snapshot.conditions['claude.compaction']?.state
    const slashPicker = snapshot.conditions['claude.slash-picker']?.state

    return {
      ...runtime,
      conditions: snapshot,
      pendingTrustDialog: trust?.visible ? { workspace: trust.workspace } : null,
      pendingResumePrompt: resume?.visible
        ? {
            sessionAgeText: resume.sessionAgeText,
            tokenCountText: resume.tokenCountText,
            selectedIndex: resume.selectedIndex,
          }
        : null,
      pendingPermissionPrompt: permission?.visible
        ? {
            title: permission.title,
            toolName: permission.toolName,
            command: permission.command,
            options: permission.options,
            selectedIndex: permission.selectedIndex,
          }
        : null,
      pendingCompaction: compaction?.visible && compaction.phase
        ? {
            phase: compaction.phase,
            statusText: compaction.statusText,
            errorText: compaction.errorText,
          }
        : null,
      picker: slashPicker ?? runtime.picker,
    }
  }

  const trust = snapshot.conditions['codex.trust-dialog']?.state
  const approval = snapshot.conditions['codex.approval']?.state

  return {
    ...runtime,
    conditions: snapshot,
    pendingTrustDialog: trust?.visible ? { workspace: trust.workspace } : null,
    pendingApproval: approval
      ? {
          callId: approval.callId ?? null,
          command: approval.commandParts ?? (approval.command ? approval.command.split(/\s+/) : []),
          workdir: approval.workdir ?? null,
          reason: approval.reason,
          options: approval.options,
          selectedIndex: approval.selectedIndex,
        }
      : null,
  }
}

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
    const worktreeCache = new Map<string, WorktreeCacheEntry>()
    const recentWorkContextRawBySession = new Map<SessionId, unknown[]>()
    // Ghost orphan / superseded-GC sweep — see docs/design/ghost-system.md for the
    // canonical explanation. Runs every GHOST_ORPHAN_SWEEP_MS,
    // calls orphanStale to flag any ghost whose updatedAt has been
    // silent for longer than GHOST_ORPHAN_TTL_MS, and drops ghosts
    // that have already been superseded by durable upstream JSONL.
    //
    // WHY GC superseded ghosts here instead of during reconcileUpstream:
    // reconcile needs a short overlap window so UI ownership can move from
    // proxy ghosts to committed entries without a flicker. After that grace
    // window the ghosts are dead weight; keeping them forever turns
    // selectMergedEntries into an O(ghost-map) loop on every TileLeaf render.
    // Both reducers are reference-stable on no-op, so the sweep only replaces
    // runtime state when something actually crossed a threshold.
    const orphanSweepTimer = window.setInterval(() => {
      const now = Date.now()
      setRuntimes(prev => {
        let changed = false
        const next = { ...prev }
        for (const [sessionId, runtime] of Object.entries(prev)) {
          if (runtime.ghosts.size === 0) continue
          const orphanedGhosts = orphanStale(runtime.ghosts, now, GHOST_ORPHAN_TTL_MS)
          const nextGhosts = gcSupersededGhosts(
            orphanedGhosts,
            now,
            GHOST_SUPERSEDED_GC_MS,
          )
          if (nextGhosts === runtime.ghosts) continue
          for (const ghost of ghostsToPersist(runtime.ghosts, nextGhosts)) {
            window.api.ghostAppend(sessionId, ghost)
          }
          next[sessionId] = appendFeedDebugLog(
            { ...runtime, ghosts: nextGhosts },
            {
              layer: 'STATE',
              kind: 'ghost_orphan_sweep',
              summary: 'stale ghosts marked orphaned',
              data: {
                ghostCount: nextGhosts.size,
                orphanedCount: [...nextGhosts.values()].filter(
                  ghost => ghost._atp.orphanedAt !== undefined &&
                    runtime.ghosts.get(ghost.uuid)?._atp.orphanedAt === undefined,
                ).length,
              },
            },
          )
          changed = true
        }
        return changed ? next : prev
      })
    }, GHOST_ORPHAN_SWEEP_MS)
    const refreshWorktrees = (cwd: string | null | undefined): void => {
      if (!cwd) return
      const cached = worktreeCache.get(cwd)
      const now = Date.now()
      if (cached?.inflight) return
      if (cached && now - cached.refreshedAt < WORKTREE_CACHE_TTL_MS) return

      const inflight = window.api.gitWorktrees(cwd).then(result => {
        if (!result.ok) return
        worktreeCache.set(cwd, {
          worktrees: result.worktrees,
          refreshedAt: Date.now(),
          inflight: null,
        })
        setRuntimes(prev => {
          let changed = false
          const next = { ...prev }
          for (const [sessionId, runtime] of Object.entries(prev)) {
            const meta = refs.stateRef.current.sessions[sessionId]
            if (meta?.cwd !== cwd) continue

            let workActivity = runtime.workActivity
            const recentRaw = recentWorkContextRawBySession.get(sessionId) ?? []
            for (const raw of recentRaw) {
              workActivity = ingestWorktreeRawEvent({
                state: workActivity,
                raw,
                worktrees: result.worktrees,
                sessionCwd: cwd,
              })
            }

            workActivity = canonicalizeWorktreeActivity(
              withFallbackWorktreeActivity({
                state: workActivity,
                sessionCwd: cwd,
                worktrees: result.worktrees,
                source: 'fallback:session-cwd:worktree-cache',
              }),
              result.worktrees,
            )
            const workContext = deriveAgentWorkContext(workActivity)

            if (
              workContext === runtime.workContext &&
              workActivity === runtime.workActivity
            ) continue
            next[sessionId] = { ...runtime, workContext, workActivity }
            changed = true
          }
          return changed ? next : prev
        })
      }).catch(() => {
        // Worktree context is decorative metadata. If git probing fails,
        // leave the last known cache in place and keep feed ingestion moving.
      }).finally(() => {
        const latest = worktreeCache.get(cwd)
        if (latest?.inflight === inflight) {
          worktreeCache.set(cwd, { ...latest, inflight: null })
        }
      })
      worktreeCache.set(cwd, {
        worktrees: cached?.worktrees ?? [],
        refreshedAt: cached?.refreshedAt ?? 0,
        inflight,
      })
    }

    const withUnread = (
      runtime: SessionRuntime,
      kind: 'output' | 'attention',
    ): SessionRuntime => {
      // Unread is an acknowledgement marker, not a focus marker.
      // Dispatch navigation, tab restore, and automatic focus sync can all
      // make a session "focused" without the user reading or acting on it.
      // Writers therefore mark only meaningful milestones unread: ordinary
      // output waits until the agent turn finishes, while attention prompts
      // still surface immediately. Explicit engagement handlers (composer
      // edit/click/paste, feed scroll/click, terminal click/input, action
      // sends) clear it via acknowledgeSession().
      // Attention outranks ordinary output: once a permission/trust
      // prompt appears, the list should keep showing ACTION until
      // the user opens that agent or the prompt resolves. A later
      // transcript append must not downgrade the marker to NEW.
      const unreadKind =
        runtime.unreadKind === 'attention' || kind === 'attention'
          ? 'attention'
          : 'output'
      return {
        ...runtime,
        unreadSince: runtime.unreadSince ?? Date.now(),
        unreadKind,
      }
    }

    const offStarted = window.api.onSessionStarted(({ sessionId, projectDir }) => {
      updateRuntime(sessionId, {
        projectDir,
        processStatus: 'started',
        processError: null,
        inputReady: true,
      })
      const cwd = refs.stateRef.current.sessions[sessionId]?.cwd ?? projectDir
      refreshWorktrees(cwd)
      appendFeedDebug(sessionId, {
        layer: 'STATE',
        kind: 'session_started',
        summary: `session started${projectDir ? ` · ${projectDir}` : ''}`,
        data: { projectDir },
      })
    })

    const offScreen = window.api.onSessionScreen(
      ({ sessionId, plain, markdown, recent, recentMarkdown, picker }) => {
        const startedAt = performance.now()
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
            const durationMs = performance.now() - startedAt
            if (durationMs > 8) {
              perf.metric('workspace.ipc.screen.noop.slow', durationMs, 'sample', {
                sessionId,
                recentLength: recent.length,
              })
            }
            return prev
          }
          const changed: string[] = []
          if (current.screen !== plain) changed.push('screen')
          if (current.recentScreen !== recent) changed.push('recent')
          if (current.screenMarkdown !== markdown) changed.push('markdown')
          if (!pickerEqual(current.picker, picker)) changed.push('picker')
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
            pickerEqual(current.picker, picker)

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
                    recentLength: recent.length,
                  },
                },
              )
          if (!chromeTickOnly) {
            recordScreenTailSnapshot(sessionId, recent)
          }
          const durationMs = performance.now() - startedAt
          if (durationMs > 8) {
            perf.metric('workspace.ipc.screen.apply.slow', durationMs, 'sample', {
              sessionId,
              changed,
              recentLength: recent.length,
              pickerVisible: picker.visible,
            })
          }
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
      updateRuntime(sessionId, {
        transcriptStatus: 'error',
        transcriptError: message,
      })
    })

    const offExit = window.api.onSessionExit(({ sessionId, exitCode }) => {
      recentWorkContextRawBySession.delete(sessionId)
      codexCurrentTurnIdBySession.delete(sessionId)
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
              processStatus: 'exited',
              processError: null,
              inputReady: false,
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
          const sessionKind = refs.stateRef.current.sessions[sessionId]?.kind
          const shouldClearIdleCodexQueue = shouldClearIdleCodexQueuedMessages({
            awaitingAssistant: false,
            processActive: active,
            provider: sessionKind,
            queuedMessagesLength: current.queuedMessages.length,
            streamPhase: current.streamPhase,
          })
          const next = withDerivedSessionStatus(
            appendFeedDebugLog(
              {
                ...current,
                processActive: active,
                processStatus: current.exited === null ? 'started' : current.processStatus,
                processError: null,
                inputReady: current.exited === null,
                activityStatus: active ? (status ?? null) : null,
                awaitingAssistant: false,
                queuedMessages: shouldClearIdleCodexQueue
                  ? []
                  : current.queuedMessages,
              },
              {
                layer: 'STATE',
                kind: 'process_state',
                summary: active
                  ? `process active${status ? ` · ${status}` : ''}`
                  : shouldClearIdleCodexQueue
                    ? 'process idle · cleared stale Codex queue'
                    : 'process idle',
                data: {
                  active,
                  status: status ?? null,
                  clearedQueuedMessages: shouldClearIdleCodexQueue
                    ? current.queuedMessages.length
                    : 0,
                },
              },
            ),
          )
          return { ...prev, [sessionId]: next }
        })
      },
    )

    const offSemantic = window.api.onSessionSemanticEvent(({ sessionId, event }) => {
      const span = perf.span('workspace.ipc.semantic.fold', { sessionId })
      let spanClosed = false
      const closeSpan = (data: Record<string, unknown>) => {
        if (spanClosed) return
        spanClosed = true
        span.end(data)
      }
      const semanticEvent = asRecord(event) ?? {}
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

        // prompt_suggestion is an ephemeral next-prompt hint, NOT a turn. It
        // must never enter foldSemanticEvent / semantic history (that is the
        // #174 leak). Handle it out-of-band: write the per-session runtime
        // field and return before the turn / ghost / phase machinery runs.
        if (semanticEvent.type === 'prompt_suggestion') {
          const updated = applyPromptSuggestionToRuntime(current, semanticEvent)
          if (updated === current) {
            closeSpan({ sessionId, eventType: 'prompt_suggestion', changed: false })
            return prev
          }
          closeSpan({ sessionId, eventType: 'prompt_suggestion', changed: true })
          return { ...prev, [sessionId]: updated }
        }

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
              stringField(semanticEvent, 'toolName')
            streamPhasePendingToolUseId =
              stringField(semanticEvent, 'toolUseId')
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
              stringField(semanticEvent, 'toolName') ?? streamPhasePendingToolName
            streamPhasePendingToolUseId =
              stringField(semanticEvent, 'toolUseId') ?? streamPhasePendingToolUseId
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
            stringField(semanticEvent, 'toolUseId')
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
        // events) do not churn the map. See
        // docs/design/ghost-system.md for the canonical explanation.
        //
        // WHY here and not inside `foldSemanticEvent`:
        //   foldSemanticEvent is intentionally agnostic to
        //   SessionRuntime — it reduces the SemanticRuntimeState
        //   sub-slice and knows nothing about sessionId or the
        //   outer runtime. The ghost map lives on SessionRuntime
        //   because it needs to survive across semantic history
        //   archival (when `currentTurn` flips to null) and because
        //   the ghost journal persists it to disk with session-
        //   scoped file names. Calling the ghost reducer at this
        //   outer boundary keeps the layering clean.
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
        const nextAwaitingAssistant = clearOptimisticAwaiting
          ? false
          : current.awaitingAssistant
        const shouldClearIdleCodexQueue = shouldClearIdleCodexQueuedMessages({
          awaitingAssistant: nextAwaitingAssistant,
          processActive: current.processActive,
          provider: sessionKind,
          queuedMessagesLength: current.queuedMessages.length,
          streamPhase,
        })
        if (
          semanticUnchanged &&
          phaseUnchanged &&
          ghostsUnchanged &&
          awaitingUnchanged &&
          !shouldClearIdleCodexQueue
        ) {
          closeSpan({
            sessionId,
            eventType: eventType || 'semantic',
            changed: false,
          })
          return prev
        }

        const nextCurrent = withDerivedSessionStatus(
          appendFeedDebugLog(
            {
              ...current,
              awaitingAssistant: nextAwaitingAssistant,
              queuedMessages: shouldClearIdleCodexQueue
                ? []
                : current.queuedMessages,
              // A suggestion is an offer about the NEXT input; once a new
              // turn begins it is stale, so clear it on turn_started. The
              // chip's apply/dismiss/submit paths clear it directly too.
              promptSuggestion:
                eventType === 'turn_started' ? null : current.promptSuggestion,
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
              summary: shouldClearIdleCodexQueue
                ? `${summarizeSemanticEventForDebug(semanticEvent)} · cleared stale Codex queue`
                : summarizeSemanticEventForDebug(semanticEvent),
              data: shouldClearIdleCodexQueue
                ? {
                    ...semanticEvent,
                    clearedQueuedMessages: current.queuedMessages.length,
                  }
                : semanticEvent,
            },
          ),
        )
        const finishedTurn =
          eventType === 'turn_completed' || eventType === 'turn_stopped'
        const nextCurrentWithUnread = finishedTurn
          ? withUnread(nextCurrent, 'output')
          : nextCurrent
        return {
          ...prev,
          [sessionId]: nextCurrentWithUnread,
        }
      })
      closeSpan({
        sessionId,
        eventType: typeof semanticEvent.type === 'string' ? semanticEvent.type : 'semantic',
        scheduled: true,
      })
    })

    const offConditions = window.api.onSessionConditions(({ sessionId, snapshot }) => {
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        const next = applyConditionSnapshot(current, snapshot)
        const conditionCount = Object.keys(snapshot.conditions).length
        const hadAttention =
          current.pendingApproval !== null ||
          current.pendingTrustDialog !== null ||
          current.pendingResumePrompt !== null ||
          current.pendingPermissionPrompt !== null
        const hasAttention =
          next.pendingApproval !== null ||
          next.pendingTrustDialog !== null ||
          next.pendingResumePrompt !== null ||
          next.pendingPermissionPrompt !== null
        const logged = appendFeedDebugLog(
          next,
          {
            layer: 'STATE',
            kind: 'conditions',
            summary: `${snapshot.provider} conditions · ${conditionCount}`,
            data: snapshot,
          },
        )
        return {
          ...prev,
          [sessionId]: !hadAttention && hasAttention
            ? withUnread(logged, 'attention')
            : logged,
        }
      })
    })

    // Subagent fleet state. Main pushes the FULL per-session map on every
    // change (it's small — agentType/description + a capped tool-call
    // timeline), so we just replace the field wholesale. Reference-equal bail
    // keeps Feed from re-rendering when an unrelated session updates.
    const offSubAgents = window.api.onSessionSubAgents(({ sessionId, subAgents }) => {
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        if (current.subAgents === subAgents) return prev
        return { ...prev, [sessionId]: { ...current, subAgents } }
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
    //   2. Codex approval request / resolve now lives in codex-headless
    //      conditions; this handler only consumes entries/feed effects.
    //   3. Claude queue-operation bookkeeping (per entry).
    //   4. Claude providerSessionId capture (from any entry's sessionId).
    //   5. pendingCompaction clearing on compact summary entries.
    //   6. Optimistic-Codex-user reconciliation against the head row.
    const offEntries = window.api.onSessionJsonlEntries(({ sessionId, entries }) => {
      if (!entries || entries.length === 0) return
      const span = perf.span('workspace.ipc.jsonl.bulk', {
        sessionId,
        burstSize: entries.length,
      })
      let spanClosed = false
      const closeSpan = (data: Record<string, unknown>) => {
        if (spanClosed) return
        spanClosed = true
        span.end(data)
      }
      appendRecentWorkContextRaw(recentWorkContextRawBySession, sessionId, entries)
      const sessionCwd = refs.stateRef.current.sessions[sessionId]?.cwd
      refreshWorktrees(sessionCwd)

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
        let queuedMessages = current.queuedMessages
        let awaitingAssistant = current.awaitingAssistant
        let workActivity = current.workActivity
        let workContext = current.workContext
        const cachedWorktrees = sessionCwd ? worktreeCache.get(sessionCwd) : undefined
        const hasWorktreeCache = !!cachedWorktrees && cachedWorktrees.refreshedAt > 0
        const worktrees = cachedWorktrees?.worktrees ?? []
        // Set when a Codex user entry mapped from rollout matches an
        // optimistic row already in the feed. Codex can commit tool
        // outputs before the real user message in the same burst, so
        // the optimistic row is not guaranteed to still be the tail by
        // the time the committed user entry arrives.
        let reconciledOptimisticText: string | null = null

        // Reuse the existing map references so downstream consumers
        // that hold them live (Feed contexts) keep working without
        // a re-subscribe. The runtime object itself gets a new
        // top-level reference below so React re-renders.
        const toolUseIndex = current.toolUseIndex
        const toolResultIndex = current.toolResultIndex

        // Rolling Codex turn id. `turn_context` was the first source we
        // used, but it is too sparse for live rendering: the authoritative
        // user message that should replace the optimistic prompt can arrive
        // after unrelated tool-result user rows, in a separate burst, with
        // only `payload.turn_id` tying it back to the active task. Stamping
        // every mapped response item gives reconcileUpstream and semantic
        // ownership a stable key instead of guessing from feed position.
        let codexCurrentTurnId: string | null =
          codexCurrentTurnIdBySession.get(sessionId) ?? null

        for (const { entry: raw } of entries) {
          if (canIngestWorkContext(raw, hasWorktreeCache)) {
            workActivity = ingestWorktreeRawEvent({
              state: workActivity,
              raw,
              worktrees,
              sessionCwd: sessionCwd ?? current.projectDir ?? '',
            })
            workContext = deriveAgentWorkContext(workActivity)
          }

          // ---- Codex rollout branch ----
          if (isCodexRolloutEntry(raw)) {
            const turnContextId = codexTurnIdFromRollout(raw)
            if (turnContextId !== null) codexCurrentTurnId = turnContextId
            const payloadTurnId = codexTurnIdFromEventPayload(raw)
            if (payloadTurnId !== null) codexCurrentTurnId = payloadTurnId
            const mappedRaw = mapCodexRolloutToFeedEntries(raw)
            const mapped = mappedRaw.map(e => stampCodexTurnId(e, codexCurrentTurnId))
            const marker = mapped.length > 0 ? codexHistoryMarker(raw) : null
            if (marker && !oldestMarker) oldestMarker = marker

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
            // The old implementation only considered the optimistic
            // row when it was the feed tail, or when an optimistic-like
            // entry happened to be the last item appended in this same
            // burst. That was too positional for Codex. In the
            // 2026-04-24 bundle, the authoritative user prompt arrived
            // after three tool-result user rows, so the optimistic row
            // was no longer the tail by the time the real prompt was
            // committed. The optimistic row survived and the same user
            // text rendered twice.
            //
            // The fix is to run both checks independently. They
            // target different data (appended[] is this burst's
            // accumulator; current.entries is the pre-burst state),
            // so there's no logical conflict.
            const firstMapped = mapped[0]
            if (firstMapped?.type === 'user') {
              const mappedText = entryTextContent(firstMapped)
              // Reconcile optimistic prompts by identity, not by tail
              // position. In the captured failure, the optimistic user row
              // stayed visible while Codex committed three tool-result user
              // entries before the real user prompt. A tail-only removal
              // therefore looked at the last tool result, missed the
              // optimistic prompt, and rendered the same user text twice.
              // Restrict this to optimistic Codex user rows so a genuine
              // repeated user prompt remains visible.
              for (let idx = appended.length - 1; idx >= 0; idx -= 1) {
                const item = appended[idx]
                if (
                  isOptimisticCodexUserEntry(item) &&
                  entryTextContent(item) === mappedText
                ) {
                  appended.splice(idx, 1)
                  reconciledOptimisticText = mappedText
                }
              }
              if (
                current.entries.some(entry =>
                  isOptimisticCodexUserEntry(entry) &&
                  entryTextContent(entry) === mappedText,
                )
              ) {
                reconciledOptimisticText = mappedText
              }
              // Mid-turn Codex submits are intentionally kept in
              // queuedMessages instead of appended to entries (see
              // addOptimisticCodexUserEntry). The authoritative rollout
              // user row is the point where that local "queued" feed item
              // must disappear; otherwise the queue surface becomes the new
              // stale-bottom duplicate after the transcript catches up.
              if (queuedMessages.some(q => codexPromptsMatchForOwnership(q.content, mappedText))) {
                // WHY queued prompt reconciliation is normalized:
                // queuedMessages is only a temporary local surface for
                // a mid-turn submit. The authoritative user row comes
                // from Codex rollout, and rollout can differ from the
                // original submit by CRLF normalization, unicode form,
                // or block-join whitespace. Exact matching leaves the
                // queued prompt stuck after the real transcript row has
                // arrived, recreating the stale-bottom artifact this
                // renderer rewrite is meant to eliminate. Preserve the
                // original displayed text in the queue, but compare by
                // the same ownership key we use for render dedupe.
                queuedMessages = queuedMessages.filter(q =>
                  !codexPromptsMatchForOwnership(q.content, mappedText),
                )
                reconciledOptimisticText = mappedText
              }
            }

            for (const e of mapped) {
              const u = entryUuid(e)
              if (u) {
                if (seen.has(u)) continue
                seen.add(u)
              }
              appended.push(e)
              indexEntryIntoMaps(e, toolUseIndex, toolResultIndex)
            }
            const eventType = codexEventType(raw)
            if (
              eventType === 'task_complete' ||
              eventType === 'turn_complete' ||
              eventType === 'turn_aborted'
            ) {
              codexCurrentTurnId = null
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
          const rawRecord = asRecord(raw) ?? {}
          const feedEntry =
            extractEmbeddedClaudeProgressEntry(rawRecord) ??
            (raw as Entry)
          const marker = claudeHistoryMarker(rawRecord)
          if (marker && !oldestMarker) oldestMarker = marker
          const uuid = entryUuid(feedEntry)
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

        const baseEntries = reconciledOptimisticText !== null
          ? current.entries.filter(entry =>
              !(
                isOptimisticCodexUserEntry(entry) &&
                entryTextContent(entry) === reconciledOptimisticText
              ),
            )
          : current.entries

        // Track the newest JSONL entry timestamp this session has
        // ever observed. selectMergedEntries uses this to decide
        // whether an orphaned ghost is past the JSONL tail (render —
        // proxy stalled past disk) or covered by it (hide — JSONL
        // kept writing past this ghost, so it's a sidecar leak
        // Claude Code never logs to its rollout). Comparison uses
        // entry.timestamp (ISO 8601 on both Claude and Codex
        // entries), NOT Date.now(), because on resume after a crash
        // we want apples-to-apples wall-clock semantics with ghost
        // _atp.updatedAt — both sides represent "when the producer
        // observed this," so a yesterday-vs-yesterday comparison
        // remains valid even if "now" is hours later.
        //
        // Non-conversation entries that lack `timestamp` (compact
        // boundaries, queue ops) silently pass through the
        // typeof-string guard without moving the cursor. That is
        // the correct behaviour: those entries do not represent a
        // fresh "JSONL is alive" signal at the wall clock the rest
        // of the predicate cares about.
        let lastJsonlEntryAt = current.lastJsonlEntryAt
        for (const entry of appended) {
          const ts = (entry as { timestamp?: unknown }).timestamp
          if (typeof ts !== 'string') continue
          const ms = Date.parse(ts)
          if (!Number.isFinite(ms)) continue
          if (lastJsonlEntryAt === null || ms > lastJsonlEntryAt) {
            lastJsonlEntryAt = ms
          }
        }

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

        if (codexCurrentTurnId === null) {
          codexCurrentTurnIdBySession.delete(sessionId)
        } else {
          codexCurrentTurnIdBySession.set(sessionId, codexCurrentTurnId)
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
        const lastJsonlChanged = lastJsonlEntryAt !== current.lastJsonlEntryAt
        const noChange =
          appended.length === 0 &&
          reconciledOptimisticText === null &&
          pendingCompaction === current.pendingCompaction &&
          queuedMessages === current.queuedMessages &&
          awaitingAssistant === current.awaitingAssistant &&
          workContext === current.workContext &&
          workActivity === current.workActivity &&
          !ghostsChanged &&
          !lastJsonlChanged
        if (noChange) {
          closeSpan({
            sessionId,
            burstSize: entries.length,
            appendedCount: 0,
            changed: false,
          })
          return prev
        }

        const nextEntries = appended.length > 0 || reconciledOptimisticText !== null
          ? [...baseEntries, ...appended]
          : current.entries
        const nextRuntimeBase = withDerivedSessionStatus(
          appendFeedDebugLog(
            {
              ...current,
              entries: nextEntries,
              // Bump totalEntries by however many real entries just
              // landed via this burst. `appended` is already deduped
              // against the `seen` UUID set seeded from the initial
              // history chunk, so it specifically excludes replay of
              // entries we already counted. The optimistic-reconcile
              // case doesn't need adjustment either: we never counted
              // the optimistic toward totalEntries when it was first
              // pushed (it's a transient UI placeholder), so when the
              // real entry lands and replaces it the total grows by
              // exactly one. The whole point of this field is "how
              // much work has happened on disk" — the ScrollIndicator
              // above the composer reads it as the denominator so the
              // user can tell at a glance how much further the
              // conversation has progressed while they were focused
              // on another pane.
              totalEntries: current.totalEntries + appended.length,
              historyOldestMarker: oldestMarker,
              bootstrapping: true,
              pendingCompaction,
              queuedMessages,
              awaitingAssistant,
              transcriptStatus: 'ready',
              transcriptError: null,
              workContext,
              workActivity,
              toolUseIndex,
              toolResultIndex,
              ghosts: nextGhosts,
              lastJsonlEntryAt,
            },
            {
              layer: 'JSONL',
              kind: 'jsonl_entries',
              summary:
                appended.length > 0 || reconciledOptimisticText !== null
                  ? `entries +${appended.length}${reconciledOptimisticText !== null ? ' · reconciled optimistic user' : ''}`
                  : 'jsonl side-effects only',
              data: {
                burstSize: entries.length,
                appendedCount: appended.length,
                reconciledOptimisticUser: reconciledOptimisticText !== null,
                // WHY these counts are more important than they look:
                // optimistic Codex user rows intentionally disappear
                // when the durable rollout user message arrives. In
                // the haunted failure mode, the UI symptom is exactly
                // the same as a correct reconcile ("my optimistic row
                // went away") except the replacement row is missing
                // or filtered. Logging the before/base/appended/after
                // counts lets the next debug trace distinguish a
                // healthy handoff from a removal gap without needing
                // to reproduce under a debugger.
                entryCountBefore: current.entries.length,
                entryCountBaseAfterOptimisticReconcile: baseEntries.length,
                entryCountAfter: nextEntries.length,
                reconciledOptimisticText,
                appended: appended.slice(-8).map(summarizeEntryForDebug),
                queuedMessages: queuedMessages.length,
                workContext,
                workActivity: summarizeWorktreeActivity(workActivity),
                conditions: current.conditions,
              },
            },
          ),
        )
        // WHY JSONL append does not mark ordinary output unread:
        // transcript entries can arrive many times during a single model
        // turn, and Dispatch's NEW marker is meant to mean "the agent's turn
        // is complete and ready to review." The semantic handler above marks
        // ordinary unread on `turn_completed` / `turn_stopped`; this bulk
        // ingest path only commits durable entries and side effects. Keeping
        // unread out of this path also avoids reviving the old per-append NEW
        // behavior when provider-specific condition handling changes.
        const nextRuntime = nextRuntimeBase
        closeSpan({
          sessionId,
          burstSize: entries.length,
          appendedCount: appended.length,
          reconciledOptimisticUser: reconciledOptimisticText !== null,
          ghostsChanged,
          queuedMessages: queuedMessages.length,
        })
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

          // Reconcile flags that JSONL replay opened but never
          // explicitly closed. Two distinct shapes have been
          // observed in production debug bundles, both producing
          // sessionStatus='running' on rehydrated panes that the
          // user has not touched in days:
          //
          //   1) Claude queue-op replay leaves awaitingAssistant=true.
          //      The queue-op handler in handleBulkJsonl forces
          //      `awaitingAssistant = true` on enqueue (so the
          //      streaming card spans cross-turn queue drain) but
          //      has no symmetric clear on the final dequeue.
          //      During live operation the next `turn_completed` /
          //      `turn_stopped` semantic event clears it via
          //      clearOptimisticAwaiting; during JSONL replay no
          //      semantic events re-fire, so the flag stays true.
          //      Evidence: scripts/diag-stuck-running.mjs against
          //      production debug bundles, Claude case
          //      `sessionStatusSource: "submit"` with
          //      `submittedAt: null` (setStreamingBaseline never
          //      ran — only the queue-op path could have set the
          //      flag).
          //
          //   2) Codex rollout replay leaves
          //      semantic.currentTurn open. A rollout-sourced
          //      `turn_started` opens currentTurn, but no matching
          //      `turn_completed`/`turn_stopped` arrives in the
          //      replay stream. Same diagnostic confirms 7+
          //      Codex sessions stuck this way after the user's
          //      last app restart.
          //
          // Why HERE: this callback fires once the bulk-JSONL bursts
          // for a session have been quiet for 150ms — i.e. replay
          // has finished. Reconciling earlier (per-burst) would
          // race a still-streaming live tail; reconciling later
          // (e.g. on idle timer) would let dispatch render
          // 'running' for the entire window. The bootstrap_complete
          // boundary is the natural "replay is done, take stock"
          // seam.
          //
          // Safety: we only reconcile when there's NO live signal
          // (processActive=false AND streamPhase='idle'). If the
          // pane is genuinely mid-turn at the moment the timer
          // fires, processActive will be true (resume spinner) or
          // streamPhase non-idle and we leave state untouched. A
          // resumed-but-genuinely-running pane that briefly drops
          // both signals between events would only get its stuck
          // flag reset for one tick before live events reopen it,
          // which is a far better failure mode than the existing
          // "permanently lying about running for days."
          const hasLiveSignal =
            current.processActive || current.streamPhase !== 'idle'
          const sessionKind = refs.stateRef.current.sessions[sessionId]?.kind
          let next = current
          const reconciled: string[] = []

          if (
            !hasLiveSignal &&
            next.awaitingAssistant &&
            next.queuedMessages.length === 0
          ) {
            next = { ...next, awaitingAssistant: false }
            reconciled.push('awaitingAssistant')
          }

          if (
            shouldClearIdleCodexQueuedMessages({
              // At bootstrap-complete, no live process/stream signal means
              // the optimistic submit owner has already lost its provider
              // evidence. Let the Codex queue invariant clear the local row
              // even if `awaitingAssistant` is itself one of the stale replay
              // flags left behind by the same missing rollout handoff.
              awaitingAssistant: false,
              processActive: current.processActive,
              provider: sessionKind,
              queuedMessagesLength: next.queuedMessages.length,
              streamPhase: current.streamPhase,
            })
          ) {
            next = { ...next, awaitingAssistant: false, queuedMessages: [] }
            if (!reconciled.includes('awaitingAssistant')) {
              reconciled.push('awaitingAssistant')
            }
            reconciled.push('queuedMessages')
          }

          const currentTurn = next.semantic.currentTurn
          if (
            !hasLiveSignal &&
            isSemanticTurnRunning(currentTurn)
          ) {
            // Mirror the turn_completed close path in foldEvent.ts —
            // archive into history with endedAt stamped, then clear
            // currentTurn. We do NOT call hasPendingSemanticTools()
            // here: that gate exists to keep currentTurn alive while
            // a cross-turn tool_result is in flight, which is a
            // live-only concern. After replay quiesces with no live
            // signal, any pending tool result has already been
            // missed and there's no value in keeping the turn open.
            const closedTurn = {
              ...currentTurn,
              endedAt: currentTurn.endedAt ?? Date.now(),
            }
            next = {
              ...next,
              semantic: {
                ...next.semantic,
                history: [
                  ...next.semantic.history,
                  semanticHistoryRow(closedTurn),
                ].slice(-SEMANTIC_HISTORY_CAP),
                currentTurn: null,
              },
            }
            reconciled.push('semantic.currentTurn')
          }

          // withDerivedSessionStatus re-runs the
          //   exited > semantic > process > submit > idle
          // priority chain so sessionStatus matches the cleaned
          // inputs. Without it the runtime would keep the stale
          // 'running' string alongside the cleared inputs.
          const finalized = withDerivedSessionStatus({
            ...next,
            bootstrapping: false,
          })

          return {
            ...prev,
            [sessionId]: appendFeedDebugLog(
              finalized,
              {
                layer: 'STATE',
                kind: 'bootstrap_complete',
                summary: reconciled.length === 0
                  ? 'bootstrap replay quiet window elapsed'
                  : `bootstrap replay closed: ${reconciled.join(', ')}`,
                data: reconciled.length === 0 ? undefined : { reconciled },
              },
            ),
          }
        })
      }, 150)
      refs.bootstrapTimersRef.current.set(sessionId, timer)
      closeSpan({
        sessionId,
        burstSize: entries.length,
        scheduled: true,
      })
    })

    return () => {
      window.clearInterval(orphanSweepTimer)
      offStarted()
      offScreen()
      // No singular offEntry() — see the deleted-handler comment
      // above. The bulk path is the only one.
      offEntries()
      offErr()
      offProcessState()
      offSemantic()
      offConditions()
      offSubAgents()
      offExit()
      for (const t of refs.bootstrapTimersRef.current.values()) clearTimeout(t)
      refs.bootstrapTimersRef.current.clear()
    }
  }, [appendFeedDebug, refs, setRuntimes, setState, updateRuntime])
}
