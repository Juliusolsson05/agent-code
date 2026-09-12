import { useCallback, useRef } from 'react'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { QueuedMessage, SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId } from '@renderer/workspace/types'
import type { Entry } from '@shared/types/transcript'
import {
  appendFeedDebugLog,
} from '@renderer/session-runtime/feedDebug'
import { withDerivedSessionStatus } from '@renderer/session-runtime/semantic/helpers'
import {
  entryTextContent,
} from '@renderer/session-runtime/entries'
import { isOptimisticCodexUserEntry } from '@providers/codex/renderer/transcript/entries'
import { isSemanticTurnRunning } from '@renderer/session-runtime/semantic/helpers'
import {
  buildCommittedAssistantText,
  semanticTurnHasRenderableContent,
} from '@renderer/features/feed/ui/semantic/renderUnits'
import {
  appendCodexTranscriptObservation,
  codexOptimisticRenderCandidateId,
} from '@renderer/lifecycle/codexTranscriptObservationOutbox'

import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'

// Optimistic submit state + optimistic-codex-user entry.
//
// beginOptimisticSubmit is called by TileLeaf on submit. It sets a
// synthetic `submitting` phase and a `submittedAt` timestamp. (It was
// `setStreamingBaseline` while it also stored an assistant block scraped
// off the TUI screen for the old screen-driven streaming card; that card
// and its baseline are gone, see #855.) This covers the gap between the user
// pressing Enter and the adapter's first `requesting` event landing
// (can be 100-500ms on a cold proxy). Without it the in-feed
// WorkIndicator would render nothing during that window, making the
// app look unresponsive to the submit. The adapter's first
// stream_phase event will transition phase → 'requesting' and reuse
// `submittedAt` as turnStartedAt.
//
// The optimistic Codex user entry pair exists because Codex live
// rendering is TUI-first, with rollout JSON as a later source of
// truth. That means a broken/missing rollout attach should NOT leave
// the feed blank after submit. We add a local user row immediately
// and reconcile it away when the real rollout user message shows up
// (see ipc/handleBulkJsonl.ts for the reconciliation side).

/** Why a submit queued instead of painting an optimistic row — recorded on
 *  the optimistic_user_queue feed-debug entry so a stuck-queue bundle says
 *  WHICH branch parked it (residue-plan P0 observability: the 06-24 stuck
 *  bundles required manual rollout forensics to distinguish "live turn"
 *  from "unowned history because the committed tail is dead"). */
export type OptimisticQueueReason = 'live-current-turn' | 'unowned-history'

/**
 * Proof that ONE submit wrote the optimistic `submitting` claim: the exact
 * `submittedAt` value that submit stamped. `beginOptimisticSubmit` returns it
 * (null when it skipped the stamp) and `settleQueuedSubmit` reverts only a
 * runtime that still carries this exact value.
 *
 * WHY a token instead of "is the phase still `submitting`?" (#893 review,
 * Codex major / Claude F1): the phase says SOME submit stamped it, not which
 * one. Submit A on an idle pane stamps and gets a `user` acceptance, so the
 * composer releases its in-flight guard while the stamp waits for A's first
 * provider event (100-500 ms on a cold proxy). Submit B in that gap skips its
 * own stamp (the pane is not idle), Claude queues B, and a phase-only settle
 * then reverted A's legitimate claim, blanking the WorkIndicator and losing
 * A's submit-to-first-event clock. `turn_started` cannot repair that, because
 * its bridge only advances `submitting`/`requesting`, never `idle`.
 *
 * WHY `submittedAt` and not a new SessionRuntime field: a new field would ride
 * into every debug bundle and runtime spread, which is the cost plan D1 already
 * refused, and `submittedAt` is written by exactly one site (the stamp below)
 * and cleared by the paths that retire the claim. What makes it a sound token
 * is that issued values are unique. `beginOptimisticSubmit` clamps them to be
 * strictly increasing, so two stamps within one millisecond can never compare
 * equal.
 */
export type OptimisticSubmitStamp = number

export function optimisticCodexQueueReason(
  current: Pick<
    SessionRuntime,
    'entries' | 'semantic' | 'streamPhase' | 'toolResultIndex' | 'toolUseIndex'
  >,
): OptimisticQueueReason | null {
  // WHY this deliberately ignores `streamPhase`:
  // TileLeaf calls beginOptimisticSubmit() and addOptimisticCodexUserEntry()
  // in the same submit handler. beginOptimisticSubmit moves streamPhase to
  // "submitting" before this function runs, so treating any non-idle
  // streamPhase as "previous turn is live" queues the *first* prompt of an
  // idle Codex session and makes the optimistic feed row path unreachable.
  //
  // The ordering bug we are preventing is narrower: a follow-up prompt
  // while an existing semantic assistant/tool turn is still visibly live.
  // That is the reliable ownership signal. Stream phase is useful for the
  // work indicator, but it is polluted by the current submit and cannot
  // answer "is there older live feed content this prompt must not jump
  // above?"
  if (isSemanticTurnRunning(current.semantic.currentTurn)) return 'live-current-turn'

  // WHY completed semantic history is part of this ownership test:
  // Feed renders in planes: committed/optimistic entries first, then
  // semantic history/current, then work. A Codex submit that becomes a
  // normal optimistic Entry while a previous completed semantic turn is
  // still renderable therefore lands above the previous turn's semantic
  // bridge and the work row. The prompt is "present" in the DOM, but it
  // is no longer the latest user action visually — exactly the #239
  // failure. Raw history length is too broad because history can linger
  // after committed rows already own its visible content, so mirror the
  // Feed renderability predicate with the same committed text/tool
  // ownership inputs.
  const committedAssistantText = buildCommittedAssistantText(current.entries)
  const unownedHistory = current.semantic.history.some(turn =>
    turn.turnId !== current.semantic.currentTurn?.turnId &&
    semanticTurnHasRenderableContent(
      turn,
      current.toolUseIndex,
      current.toolResultIndex,
      committedAssistantText,
    ),
  )
  return unownedHistory ? 'unowned-history' : null
}

export function codexPromptOwnershipKey(text: string | null | undefined): string {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
}

export function codexPromptsMatchForOwnership(
  queuedText: string | null | undefined,
  committedText: string | null | undefined,
): boolean {
  const queuedKey = codexPromptOwnershipKey(queuedText)
  const committedKey = codexPromptOwnershipKey(committedText)
  return queuedKey !== '' && queuedKey === committedKey
}

// Diagnostic correlation must not become an enumerable field on product rows:
// entry serialization feeds byte estimates, recordings, fixtures, and provider
// adapters. Weak ownership riders disappear with the row, survive normal React
// reference-preserving folds, and make Stage 0 literally removable without
// changing an Entry or QueuedMessage's wire shape.
type SubmissionOwnership = { submissionId: string; sessionRunId: string | null }
const optimisticSubmissionOwnership = new WeakMap<Entry, SubmissionOwnership>()
const queuedSubmissionOwnership = new WeakMap<QueuedMessage, SubmissionOwnership>()

export function optimisticEntrySubmissionId(entry: Entry): string | null {
  return optimisticSubmissionOwnership.get(entry)?.submissionId ?? null
}

export function optimisticEntrySubmissionRunId(entry: Entry): string | null {
  return optimisticSubmissionOwnership.get(entry)?.sessionRunId ?? null
}

export function queuedMessageSubmissionId(message: QueuedMessage): string | null {
  return queuedSubmissionOwnership.get(message)?.submissionId ?? null
}

export function queuedMessageSubmissionRunId(message: QueuedMessage): string | null {
  return queuedSubmissionOwnership.get(message)?.sessionRunId ?? null
}

export function useStreamingActions(
  setRuntimes: WorkspaceSetRuntimes,
  isCodexSession: (sessionId: SessionId) => boolean,
): {
  beginOptimisticSubmit: (sessionId: SessionId) => OptimisticSubmitStamp | null
  unwindOptimisticSubmit: (sessionId: SessionId) => void
  settleQueuedSubmit: (sessionId: SessionId, stamp: OptimisticSubmitStamp | null) => void
  clearPendingRewindUndo: (sessionId: SessionId) => void
  addOptimisticCodexUserEntry: (
    sessionId: SessionId,
    text: string,
    submissionId?: string,
    sessionRunId?: string | null,
  ) => void
  removeOptimisticCodexUserEntry: (
    sessionId: SessionId,
    text: string,
    submissionId?: string,
    sessionRunId?: string | null,
    releaseCause?: 'before-write-failure' | 'write-status-uncertain',
  ) => void
} {
  const clearPendingRewindUndo = useCallback(
    (sessionId: SessionId) => {
      setRuntimes(prev => {
        const current = prev[sessionId]
        if (!current?.pendingRewindUndo) return prev
        // WHY this exists separately from beginOptimisticSubmit:
        // Normal composer submits already have a rich optimistic-submit path
        // that can clear Undo Rewind while updating streaming state. Slash-mode
        // commits write directly to the provider PTY and may start a real turn
        // without touching that path. Clearing only this field lets those
        // alternate submit routes honor the same "undo is gone once you
        // continue the rewound branch" contract without lying to the feed that
        // a normal text submit has begun.
        return {
          ...prev,
          [sessionId]: {
            ...current,
            pendingRewindUndo: null,
          },
        }
      })
    },
    [setRuntimes],
  )

  /**
   * Undo the optimistic submit state when the prompt provably never reached the
   * provider.
   *
   * ── THE BUG THIS FIXES ──
   *
   * `beginOptimisticSubmit` sets `streamPhase: 'submitting'` BEFORE the delivery
   * attempt. When delivery failed, the catch in `useComposerKeybinds` recorded
   * the failure and showed a toast — but never touched the phase. And nothing
   * else could: there are exactly three paths back to `'idle'`, and under a
   * before-write failure none of them can fire.
   *
   *   1. `onSessionExit` needs a real exit event. Main holds no registry entry
   *      to exit — that IS the failure.
   *   2. `emptyRuntime()` only happens on a fresh runtime, i.e. an agent
   *      reload. This is why reloading was the only escape.
   *   3. `reduceStreamPhase` needs a provider semantic event. Nothing was
   *      written, so none will arrive — and `streamPhaseMachine` deliberately
   *      refuses to stomp `'submitting'` from screen-derived signals anyway.
   *
   * So `WorkIndicator` rendered `Sending` and `useElapsedSeconds` counted up
   * forever: `Sending · 17s`, `Sending · 4m`, until the agent was reloaded.
   *
   * ── WHY THIS IS NOT THE CONDITIONAL TRAP ──
   *
   * The repeated failure mode in this subsystem is a guard added to protect one
   * path becoming the weapon on another (#548's kill-timeout became #596;
   * TileLeaf's `!inputReady` gate became #598). Both were guards that INFERRED
   * state. This does not infer: the caller unwinds only when main REPORTS that
   * neither the body nor Enter was written. Nothing written means no turn can
   * start, so the optimistic phase is provably a lie — not probably one.
   *
   * The `uncertain` case (something WAS written) is deliberately untouched.
   * There a turn may genuinely be starting and unwinding could hide it.
   *
   * Equally deliberate: this does NOT relax the `submitting`/`requesting` guard
   * in `streamPhaseMachine`. That guard is a shipped regression's tombstone.
   * The unwind belongs at the site that OWNS the optimistic set.
   */
  const unwindOptimisticSubmit = useCallback(
    (sessionId: SessionId) => {
      setRuntimes(prev => {
        const current = prev[sessionId]
        if (!current) return prev
        // Only unwind what this submit actually set. A provider event that
        // arrived between the optimistic write and the failure is real, and
        // stomping it would trade a stuck spinner for a lost turn — the exact
        // suppress-before-replace shape the rendering pipeline is built to
        // avoid.
        if (current.streamPhase !== 'submitting') return prev
        return {
          ...prev,
          [sessionId]: withDerivedSessionStatus(
            appendFeedDebugLog(
              {
                ...current,
                streamPhase: 'idle',
                streamPhasePendingToolName: null,
                streamPhasePendingToolUseId: null,
                submittedAt: null,
                turnStartedAt: null,
                phaseChangedAt: null,
                awaitingAssistant: false,
              },
              {
                layer: 'STATE',
                kind: 'submit',
                summary: 'submit unwound: nothing was written to the provider',
              },
            ),
          ),
        }
      })
    },
    [setRuntimes],
  )

  /**
   * Settle a stamped `submitting` phase after main reports that the provider
   * accepted the prompt into its QUEUE rather than starting a turn (#889).
   *
   * WHY this exists next to `unwindOptimisticSubmit` instead of reusing it:
   * unwind means "nothing reached the provider" and therefore also drops
   * `awaitingAssistant`. A queued prompt DID reach the provider — Claude holds
   * it and will drain it into the running turn — so the only false claim is
   * the phase. `awaitingAssistant` and `queuedMessages` are owned by the
   * queue-operation reducer, whose enqueue burst can land a few milliseconds
   * before or after this acceptance; touching them here would race it.
   *
   * WHY the phase has to be settled at all: a queued prompt starts no turn, so
   * the `turn_started` bridge in streamPhaseMachine never fires for it, and
   * the machine deliberately refuses to stomp `submitting` from screen
   * signals. Left alone, the WorkIndicator paints `Sending · Ns` until the
   * RUNNING turn happens to emit its next `stream_phase` event — 21 s and 46 s
   * in the 2026-09-11 recordings, over a turn that was visibly thinking.
   *
   * Only ever reverts THIS submit's `submitting`. Two things must both hold:
   *   - The phase is still `submitting`. If a real event moved it between the
   *     stamp and the acceptance, that phase is the truth (the same rule as
   *     unwind).
   *   - `submittedAt` is the stamp this submit wrote. A null stamp means this
   *     submit painted nothing, so there is nothing of its own to settle. A
   *     different value means the claim belongs to another submit, which may
   *     be a turn that is genuinely starting (see OptimisticSubmitStamp for
   *     the recorded two-submit sequence).
   */
  const settleQueuedSubmit = useCallback(
    (sessionId: SessionId, stamp: OptimisticSubmitStamp | null) => {
      setRuntimes(prev => {
        const current = prev[sessionId]
        if (!current) return prev
        if (
          stamp === null ||
          current.streamPhase !== 'submitting' ||
          current.submittedAt !== stamp
        ) return prev
        return {
          ...prev,
          [sessionId]: withDerivedSessionStatus(
            appendFeedDebugLog(
              {
                ...current,
                streamPhase: 'idle',
                streamPhasePendingToolName: null,
                streamPhasePendingToolUseId: null,
                submittedAt: null,
                turnStartedAt: null,
                phaseChangedAt: null,
              },
              {
                layer: 'STATE',
                kind: 'submit',
                summary: 'submit queued: provider accepted the prompt into its queue, optimistic phase settled',
              },
            ),
          ),
        }
      })
    },
    [setRuntimes],
  )

  // The last stamp this controller issued, across every session. It exists
  // only to keep issued stamps strictly increasing; see OptimisticSubmitStamp.
  const lastIssuedStampRef = useRef(0)

  const beginOptimisticSubmit = useCallback(
    (sessionId: SessionId): OptimisticSubmitStamp | null => {
      // Clamped to be strictly increasing rather than raw `Date.now()`: the stamp
      // doubles as the settle's ownership token, and two stamps written in the
      // same millisecond would be indistinguishable. The clamp moves such a stamp
      // by at most a few milliseconds, which the whole-second elapsed counter
      // cannot show. A value burned by a skipped stamp costs nothing.
      const now = Math.max(Date.now(), lastIssuedStampRef.current + 1)
      lastIssuedStampRef.current = now
      // WHY the token is decided INSIDE the updater and read after it: whether
      // this submit stamps can only be judged against the `prev` the write is
      // applied to. Reading the store before or after `setRuntimes` would race
      // any IPC fold that lands in between. `setWorkspaceRuntimes` is a zustand
      // `set` whose updater runs synchronously, exactly once, before it returns
      // (app-state/workspace/slice.ts), so `stamp` holds the committed decision
      // by the time we return it. Each branch assigns it explicitly, so even a
      // re-run reports its last decision. If the updater somehow never ran, the
      // null default fails safe: the settle then does nothing rather than erase
      // a phase it cannot prove it owns.
      let stamp: OptimisticSubmitStamp | null = null
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        // WHY the phase stamp is skipped over a live turn (#889): a submit into
        // a pane whose turn is still running is not going to START a turn —
        // Claude queues it and drains it into the running turn later. Painting
        // `submitting` here overwrote the turn's real phase and its real
        // clock (`turnStartedAt`) with `Sending · 0s`, and because nothing
        // downstream ever corrects that (see settleQueuedSubmit), the pane lied
        // for as long as the turn stayed quiet. Both live signals are checked:
        // the phase machine can lag the semantic turn (first deltas arrive
        // before the first stream_phase), and the semantic turn can be closed
        // while the phase still reports a pending tool.
        //
        // Everything that is not a phase claim still happens on this branch —
        // continuing from a rewound branch retires Undo Rewind whether or not
        // the prompt is queued.
        const turnIsLive =
          current.streamPhase !== 'idle' ||
          isSemanticTurnRunning(current.semantic.currentTurn)
        if (turnIsLive) {
          stamp = null
          return {
            ...prev,
            [sessionId]: withDerivedSessionStatus(
              appendFeedDebugLog(
                { ...current, pendingRewindUndo: null },
                {
                  layer: 'STATE',
                  kind: 'submit',
                  summary: 'submit started · behind a live turn (provider will queue it)',
                },
              ),
            ),
          }
        }
        stamp = now
        const next = withDerivedSessionStatus(
          appendFeedDebugLog(
            {
              ...current,
              awaitingAssistant: true,
              // Rewind undo is intentionally valid only until the user starts
              // continuing from the rewound branch. Clearing here, at the same
              // "submit started" boundary that drives optimistic streaming,
              // means the command disappears before provider output, JSONL
              // replay, or a failed write can create an ambiguous state where
              // Undo Rewind would hide new branch work from the visible pane.
              pendingRewindUndo: null,
              streamPhase: 'submitting',
              submittedAt: now,
              phaseChangedAt: now,
              turnStartedAt: now,
            },
            {
              layer: 'STATE',
              kind: 'submit',
              summary: 'submit started',
            },
          ),
        )
        return {
          ...prev,
          [sessionId]: next,
        }
      })
      return stamp
    },
    [setRuntimes],
  )

  const addOptimisticCodexUserEntry = useCallback(
    (
      sessionId: SessionId,
      text: string,
      submissionId?: string,
      sessionRunId?: string | null,
    ) => {
      const trimmed = text.trim()
      if (!trimmed) return
      // OpenCode intentionally shares the optimistic-entry mechanics, but the
      // Stage 0 evidence contract is Codex-only. Capture provider kind at the
      // action boundary so a later provider replacement cannot widen or erase
      // this submit's diagnostic blast radius while React evaluates the fold.
      const observeCodex = isCodexSession(sessionId)
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        const submitRunId = sessionRunId === undefined ? current.sessionRunId : sessionRunId
        const last = current.entries[current.entries.length - 1]
        if (isOptimisticCodexUserEntry(last) && entryTextContent(last) === trimmed) {
          // The existing product rule intentionally collapses an identical
          // adjacent optimistic row. Stage 0 must not change that rule, but it
          // must also not erase the fact that a second Enter happened. Record
          // the second submission against the already-owned candidate so two
          // identical prompts remain distinct in diagnostics.
          if (!submissionId || !observeCodex) return prev
          return {
            ...prev,
            [sessionId]: appendCodexTranscriptObservation(
              current,
              'submit.surface',
              { surface: 'duplicate-suppressed', changed: false },
              // The existing row belongs to an EARLIER submission. Reusing
              // its candidate id beside this submission id would assert they
              // are one owner; minting a candidate for this submit would claim
              // a row exists when product dedupe created none. Record only the
              // suppressed submit until Stage 4 defines an explicit many-to-one
              // ownership relation from real fixtures.
              { submissionId, sessionRunId: submitRunId ?? undefined },
            ),
          }
        }
        const queueReason = optimisticCodexQueueReason(current)
        if (queueReason !== null) {
          const alreadyQueued = current.queuedMessages.some(q =>
            codexPromptsMatchForOwnership(q.content, trimmed),
          )
          if (alreadyQueued) {
            if (!submissionId || !observeCodex) return prev
            return {
              ...prev,
              [sessionId]: appendCodexTranscriptObservation(
                current,
                'submit.surface',
                { surface: 'duplicate-suppressed', changed: false, queueReason },
                // Same invariant as the optimistic duplicate above: the
                // existing queue candidate belongs to another submission.
                { submissionId, sessionRunId: submitRunId ?? undefined },
              ),
            }
          }
          const queued = {
            content: trimmed,
            timestamp: String(Date.now()),
          }
          if (submissionId && observeCodex) {
            queuedSubmissionOwnership.set(queued, {
              submissionId,
              sessionRunId: submitRunId,
            })
          }
          const observedCurrent = submissionId && observeCodex
            ? appendCodexTranscriptObservation(
                current,
                'submit.surface',
                { surface: 'queued-strip', changed: true, queueReason },
                {
                  submissionId,
                  renderCandidateId: `queued:${submissionId}`,
                  sessionRunId: submitRunId ?? undefined,
                },
              )
            : current
          return {
            ...prev,
            [sessionId]: appendFeedDebugLog(
              {
                ...observedCurrent,
                queuedMessages: [...current.queuedMessages, queued],
                awaitingAssistant: true,
              },
              {
                layer: 'STATE',
                kind: 'optimistic_user_queue',
                summary: `optimistic user queued (${queueReason}) · ${trimmed.slice(0, 80)}`,
                // WHY queue instead of appending a normal feed row:
                // Codex lets the user submit follow-up prompts while the
                // previous assistant/tool turn is still live. Appending a
                // synthetic user Entry to `entries` during that window puts
                // it in Feed's committed-entry plane used to render before
                // semantic history/current. The 2026-05-16T19-21 bundle
                // captured the result: the future user prompt appeared one
                // level too high, above the active apply_patch plane. Keep
                // mid-turn optimistic prompts in queuedMessages instead;
                // Feed's unified item plan renders that queue surface after
                // current work without lying that the prompt is already a
                // durable transcript row.
                data: {
                  text: trimmed,
                  ...(submissionId && observeCodex ? { submissionId } : {}),
                  queueLengthBefore: current.queuedMessages.length,
                  queueLengthAfter: current.queuedMessages.length + 1,
                  queueReason,
                  streamPhase: current.streamPhase,
                  // Age of the committed tail at queue time. The tailer
                  // unwatch bug (residue plan P0) made 'unowned-history'
                  // queues with a MINUTES-old tail — this field makes the
                  // next dead-tail incident readable straight off the
                  // bundle instead of requiring rollout forensics.
                  committedTailAgeMs:
                    current.lastJsonlEntryAt !== null ? Date.now() - current.lastJsonlEntryAt : null,
                },
              },
            ),
          }
        }
        const optimistic: Entry = {
          type: 'user',
          uuid: `optimistic-codex-user:${Date.now()}`,
          parentUuid: null,
          timestamp: new Date().toISOString(),
          message: {
            role: 'user',
            content: [{ type: 'text', text: trimmed }],
          },
        }
        if (submissionId && observeCodex) {
          optimisticSubmissionOwnership.set(optimistic, {
            submissionId,
            sessionRunId: submitRunId,
          })
        }
        const observedCurrent = submissionId && observeCodex
          ? appendCodexTranscriptObservation(
              current,
              'submit.surface',
              { surface: 'optimistic-entry', changed: true },
              {
                submissionId,
                renderCandidateId: codexOptimisticRenderCandidateId(submissionId),
                sessionRunId: submitRunId ?? undefined,
              },
            )
          : current
        return {
          ...prev,
          [sessionId]: appendFeedDebugLog(
            {
              ...observedCurrent,
              entries: [...current.entries, optimistic],
            },
            {
              layer: 'STATE',
              kind: 'optimistic_user_add',
              summary: `optimistic user row added · ${trimmed.slice(0, 80)}`,
              // WHY include counts here:
              // the visible symptom is "the agent reacts to my
              // message, but my message never renders." The old log
              // proved only that the submit path ran; it did not
              // prove the runtime entries array grew. Pairing this
              // with the JSONL reconcile counts below gives the next
              // trace an exact ownership chain for the user row.
              data: {
                text: trimmed,
                ...(submissionId && observeCodex ? { submissionId } : {}),
                entryCountBefore: current.entries.length,
                entryCountAfter: current.entries.length + 1,
                uuid: optimistic.uuid,
              },
            },
          ),
        }
      })
    },
    [isCodexSession, setRuntimes],
  )

  const removeOptimisticCodexUserEntry = useCallback(
    (
      sessionId: SessionId,
      text: string,
      submissionId?: string,
      sessionRunId?: string | null,
      releaseCause: 'before-write-failure' | 'write-status-uncertain' = 'write-status-uncertain',
    ) => {
      const trimmed = text.trim()
      if (!trimmed) return
      const observeCodex = isCodexSession(sessionId)
      setRuntimes(prev => {
        const current = prev[sessionId]
        if (!current || current.entries.length === 0) return prev
        const last = current.entries[current.entries.length - 1]
        if (!isOptimisticCodexUserEntry(last) || entryTextContent(last) !== trimmed) {
          return prev
        }
        // Removing the product row and describing why are intentionally one
        // committed transition, but the caller supplies the evidence strength.
        // Codex can return from the body write and then throw on Enter; calling
        // that `before-write-failure` manufactures a fact we do not possess.
        // The neutral cause preserves the row-ownership edge without claiming
        // whether bytes reached the provider.
        const observedCurrent = submissionId && observeCodex
          ? appendCodexTranscriptObservation(
              current,
              'submit.release',
              { cause: releaseCause },
              {
                submissionId,
                sessionRunId: (
                  sessionRunId === undefined
                    ? optimisticEntrySubmissionRunId(last)
                    : sessionRunId
                ) ?? undefined,
                ...(optimisticEntrySubmissionId(last)
                  ? { renderCandidateId: codexOptimisticRenderCandidateId(optimisticEntrySubmissionId(last)!) }
                  : {}),
              },
            )
          : current
        return {
          ...prev,
          [sessionId]: appendFeedDebugLog(
            {
              ...observedCurrent,
              entries: current.entries.slice(0, -1),
            },
            {
              layer: 'STATE',
              kind: 'optimistic_user_remove',
              summary: `optimistic user row removed · ${trimmed.slice(0, 80)}`,
              data: { text: trimmed },
            },
          ),
        }
      })
    },
    [isCodexSession, setRuntimes],
  )

  return {
    beginOptimisticSubmit,
    unwindOptimisticSubmit,
    settleQueuedSubmit,
    clearPendingRewindUndo,
    addOptimisticCodexUserEntry,
    removeOptimisticCodexUserEntry,
  }
}
