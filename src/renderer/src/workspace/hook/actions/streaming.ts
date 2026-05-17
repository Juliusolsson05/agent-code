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
  current: Pick<SessionRuntime, 'semantic' | 'streamPhase'>,
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
  return isSemanticTurnRunning(current.semantic.currentTurn)
}

export function useStreamingActions(setRuntimes: WorkspaceSetRuntimes): {
  setStreamingBaseline: (sessionId: SessionId, baseline: string | null) => void
  addOptimisticCodexUserEntry: (sessionId: SessionId, text: string) => void
  removeOptimisticCodexUserEntry: (sessionId: SessionId, text: string) => void
} {
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
          const alreadyQueued = current.queuedMessages.some(q => q.content === trimmed)
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
                // it in Feed's committed plane, which renders before
                // semantic history/current turn. The 2026-05-16T19-21
                // bundle captured the result: the future user prompt
                // appeared one level too high, above the active apply_patch
                // plane. QueueStrip is the existing "about to happen"
                // surface; keeping mid-turn optimistic prompts there avoids
                // lying about transcript order while still making submit
                // visible immediately.
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
    addOptimisticCodexUserEntry,
    removeOptimisticCodexUserEntry,
  }
}
