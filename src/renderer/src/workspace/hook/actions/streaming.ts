import { useCallback } from 'react'

import { emptyRuntime, type SessionRuntime } from '@renderer/workspace/workspaceState'
import type { SessionId } from '@renderer/workspace/types'
import type { Entry } from '@shared/types/transcript'
import {
  appendFeedDebugLog,
} from '@renderer/workspace/runtime/feedDebug'
import { withDerivedSessionStatus } from '@renderer/workspace/semantic/helpers'
import {
  entryTextContent,
} from '@renderer/workspace/entries/utils'
import { isOptimisticCodexUserEntry } from '@renderer/workspace/codex/entries'
import { isSemanticTurnRunning } from '@renderer/workspace/semantic/helpers'
import {
  buildCommittedAssistantText,
  semanticTurnHasRenderableContent,
} from '@renderer/features/feed/ui/semantic/renderUnits'

import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'

// Streaming baseline + optimistic-codex-user entry.
//
// setStreamingBaseline is called by TileLeaf on submit. It pairs the
// baseline write with a synthetic `submitting` phase and a
// `submittedAt` timestamp. This covers the gap between the user
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

export function shouldQueueOptimisticCodexUserEntry(
  current: Pick<
    SessionRuntime,
    'entries' | 'semantic' | 'streamPhase' | 'toolResultIndex' | 'toolUseIndex'
  >,
): boolean {
  // WHY this deliberately ignores `streamPhase`:
  // TileLeaf calls setStreamingBaseline() and addOptimisticCodexUserEntry()
  // in the same submit handler. setStreamingBaseline moves streamPhase to
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
  if (isSemanticTurnRunning(current.semantic.currentTurn)) return true

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
  return current.semantic.history.some(turn =>
    turn.turnId !== current.semantic.currentTurn?.turnId &&
    semanticTurnHasRenderableContent(
      turn,
      current.toolUseIndex,
      current.toolResultIndex,
      committedAssistantText,
    ),
  )
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

export function useStreamingActions(setRuntimes: WorkspaceSetRuntimes): {
  setStreamingBaseline: (sessionId: SessionId, baseline: string | null) => void
  clearPendingRewindUndo: (sessionId: SessionId) => void
  addOptimisticCodexUserEntry: (sessionId: SessionId, text: string) => void
  removeOptimisticCodexUserEntry: (sessionId: SessionId, text: string) => void
} {
  const clearPendingRewindUndo = useCallback(
    (sessionId: SessionId) => {
      setRuntimes(prev => {
        const current = prev[sessionId]
        if (!current?.pendingRewindUndo) return prev
        // WHY this exists separately from setStreamingBaseline:
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

  const setStreamingBaseline = useCallback(
    (sessionId: SessionId, baseline: string | null) => {
      const now = Date.now()
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        const next = withDerivedSessionStatus(
          appendFeedDebugLog(
            {
              ...current,
              streamingBaseline: baseline,
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
              summary: baseline ? 'submit started with baseline' : 'submit started',
              data: { hasBaseline: baseline !== null, baselineLength: baseline?.length ?? 0 },
            },
          ),
        )
        return {
          ...prev,
          [sessionId]: next,
        }
      })
    },
    [setRuntimes],
  )

  const addOptimisticCodexUserEntry = useCallback(
    (sessionId: SessionId, text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      setRuntimes(prev => {
        const current = prev[sessionId] ?? emptyRuntime()
        const last = current.entries[current.entries.length - 1]
        if (isOptimisticCodexUserEntry(last) && entryTextContent(last) === trimmed) {
          return prev
        }
        const queueForLiveSemanticTurn = shouldQueueOptimisticCodexUserEntry(current)
        if (queueForLiveSemanticTurn) {
          const alreadyQueued = current.queuedMessages.some(q =>
            codexPromptsMatchForOwnership(q.content, trimmed),
          )
          if (alreadyQueued) return prev
          const queued = {
            content: trimmed,
            timestamp: String(Date.now()),
          }
          return {
            ...prev,
            [sessionId]: appendFeedDebugLog(
              {
                ...current,
                queuedMessages: [...current.queuedMessages, queued],
                awaitingAssistant: true,
              },
              {
                layer: 'STATE',
                kind: 'optimistic_user_queue',
                summary: `optimistic user queued during live turn · ${trimmed.slice(0, 80)}`,
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
                  queueLengthBefore: current.queuedMessages.length,
                  queueLengthAfter: current.queuedMessages.length + 1,
                  activeSemanticTurn: queueForLiveSemanticTurn,
                  streamPhase: current.streamPhase,
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
        return {
          ...prev,
          [sessionId]: appendFeedDebugLog(
            {
              ...current,
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
                entryCountBefore: current.entries.length,
                entryCountAfter: current.entries.length + 1,
                uuid: optimistic.uuid,
              },
            },
          ),
        }
      })
    },
    [setRuntimes],
  )

  const removeOptimisticCodexUserEntry = useCallback(
    (sessionId: SessionId, text: string) => {
      const trimmed = text.trim()
      if (!trimmed) return
      setRuntimes(prev => {
        const current = prev[sessionId]
        if (!current || current.entries.length === 0) return prev
        const last = current.entries[current.entries.length - 1]
        if (!isOptimisticCodexUserEntry(last) || entryTextContent(last) !== trimmed) {
          return prev
        }
        return {
          ...prev,
          [sessionId]: appendFeedDebugLog(
            {
              ...current,
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
    [setRuntimes],
  )

  return {
    setStreamingBaseline,
    clearPendingRewindUndo,
    addOptimisticCodexUserEntry,
    removeOptimisticCodexUserEntry,
  }
}
