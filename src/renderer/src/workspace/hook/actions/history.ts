import { useCallback } from 'react'

import { emptyRuntime, type SessionRuntime } from '@renderer/workspace/workspaceState'
import type { SessionId } from '@renderer/workspace/types'
import type { Entry } from '@shared/types/transcript'
import {
  isCompactBoundaryEntry,
  isCompactSummaryEntry,
  isConversationEntry,
} from '@shared/types/transcript'
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

import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'

// Older history loader — called by Feed's scroll handler when the
// user scrolls near the top.
//
// Walks the rollout stream linearly; the rolling Codex turn id
// maintained by `turn_context` markers still stamps response_items
// that come after it during pagination.

export function useHistoryActions(
  setRuntimes: WorkspaceSetRuntimes,
  refs: WorkspaceRefs,
  updateRuntime: (sessionId: SessionId, patch: Partial<SessionRuntime>) => void,
): {
  loadOlderHistory: (sessionId: SessionId) => Promise<void>
} {
  const loadOlderHistory = useCallback(
    async (sessionId: SessionId) => {
      const currentState = refs.stateRef.current
      const meta = currentState.sessions[sessionId]
      const runtime = refs.latestRuntimesRef.current[sessionId] ?? emptyRuntime()
      if (!meta) return

      const kind = meta.kind ?? 'claude'
      if ((kind !== 'claude' && kind !== 'codex') || !meta.providerSessionId) return
      if (!runtime.hasOlderHistory || runtime.loadingOlderHistory) return
      if (!runtime.historyOldestMarker) {
        updateRuntime(sessionId, { hasOlderHistory: false, loadingOlderHistory: false })
        return
      }

      updateRuntime(sessionId, { loadingOlderHistory: true })

      try {
        const chunk = await window.api.loadOlderHistory({
          kind,
          cwd: meta.cwd,
          providerSessionId: meta.providerSessionId,
          beforeMarker: runtime.historyOldestMarker,
          limit: 200,
        })

        const seen = (refs.seenUuidsRef.current[sessionId] ??= new Set())
        const prepend: Entry[] = []
        let oldestMarker: string | null = runtime.historyOldestMarker
        // Same rolling Codex turn id as the live JSONL ingest path
        // — loadOlderHistory walks the rollout stream linearly too,
        // so a `turn_context` marker seen during pagination still
        // stamps the response_items that come after it. See
        // codexTurnIdFromRollout.
        let codexPaginationTurnId: string | null = null

        for (const rawEntry of chunk.entries) {
          if (kind === 'codex') {
            const marker = codexHistoryMarker(rawEntry)
            const turnContextId = codexTurnIdFromRollout(rawEntry)
            if (turnContextId !== null) codexPaginationTurnId = turnContextId
            const mappedRaw = mapCodexRolloutToFeedEntries(rawEntry)
            const mapped = mappedRaw.map(e => stampCodexTurnId(e, codexPaginationTurnId))
            if (mapped.length > 0 && oldestMarker === runtime.historyOldestMarker) {
              oldestMarker = marker
            }
            for (const entry of mapped) {
              const uuid = (entry as { uuid?: string }).uuid
              if (uuid && seen.has(uuid)) continue
              if (uuid) seen.add(uuid)
              prepend.push(entry)
            }
            continue
          }

          const feedEntry =
            extractEmbeddedClaudeProgressEntry(rawEntry) ??
            (rawEntry as Entry)
          const marker = claudeHistoryMarker(rawEntry)
          if (!(
            isConversationEntry(feedEntry) ||
            isCompactBoundaryEntry(feedEntry) ||
            isCompactSummaryEntry(feedEntry)
          )) {
            continue
          }
          if (marker && oldestMarker === runtime.historyOldestMarker) {
            oldestMarker = marker
          }
          const uuid = (feedEntry as { uuid?: string }).uuid
          if (uuid && seen.has(uuid)) continue
          if (uuid) seen.add(uuid)
          prepend.push(feedEntry)
        }

        setRuntimes(prev => {
          const current = prev[sessionId] ?? emptyRuntime()
          return {
            ...prev,
            [sessionId]: {
              ...current,
              entries: prepend.length > 0 ? [...prepend, ...current.entries] : current.entries,
              historyOldestMarker: oldestMarker ?? current.historyOldestMarker,
              hasOlderHistory: chunk.hasMore || prepend.length === 0,
              loadingOlderHistory: false,
            },
          }
        })
      } catch (err) {
        console.warn('[history] load older failed', err)
        updateRuntime(sessionId, { loadingOlderHistory: false })
      }
    },
    [refs.latestRuntimesRef, refs.seenUuidsRef, refs.stateRef, setRuntimes, updateRuntime],
  )

  return { loadOlderHistory }
}
