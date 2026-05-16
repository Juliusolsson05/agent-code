import { useCallback } from 'react'

import { emptyRuntime } from '@renderer/workspace/workspaceState'
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
