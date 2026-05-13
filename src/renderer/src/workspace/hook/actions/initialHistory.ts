import type { Entry } from '@shared/types/transcript'
import {
  isCompactBoundaryEntry,
  isCompactSummaryEntry,
  isConversationEntry,
} from '@shared/types/transcript'
import { emptyRuntime, type SessionRuntime } from '@renderer/workspace/workspaceState'
import type { SessionId, SessionMeta } from '@renderer/workspace/types'
import { isCodexRolloutEntry } from '@renderer/workspace/codex/entries'
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
import { indexEntryIntoMaps } from '@renderer/workspace/entries/utils'
import { appendFeedDebugLog } from '@renderer/workspace/runtime/feedDebug'
import {
  ghostsToPersist,
  reconcileUpstream,
} from '@renderer/workspace/ghosts'
import {
  deriveAgentWorkContext,
  ingestWorktreeRawEvent,
} from '@shared/work-context/tracker'

import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import * as perf from '@renderer/performance/client'
import {
  codexEventType,
  codexTurnIdFromEventPayload,
} from '@renderer/workspace/codex/eventCursor'

function seedSeenFromRuntime(runtime: SessionRuntime, seen: Set<string>): void {
  for (const entry of runtime.entries) {
    const uuid = (entry as { uuid?: string }).uuid
    if (uuid) seen.add(uuid)
  }
}

export async function loadInitialHistoryForSession({
  sessionId,
  refs,
  setRuntimes,
  limit = 120,
  meta: metaOverride,
}: {
  sessionId: SessionId
  refs: WorkspaceRefs
  setRuntimes: WorkspaceSetRuntimes
  limit?: number
  meta?: SessionMeta
}): Promise<void> {
  const meta = metaOverride ?? refs.stateRef.current.sessions[sessionId]
  const kind = meta?.kind ?? 'claude'
  if (!meta || (kind !== 'claude' && kind !== 'codex')) return

  if (!meta.providerSessionId) {
    setRuntimes(prev => {
      const current = prev[sessionId] ?? emptyRuntime()
      return {
        ...prev,
        [sessionId]: {
          ...current,
          transcriptStatus: 'ready',
          transcriptError: null,
        },
      }
    })
    return
  }

  const span = perf.span('workspace.history.loadInitial', {
    sessionId,
    kind,
    limit,
  })

  setRuntimes(prev => {
    const current = prev[sessionId] ?? emptyRuntime()
    return {
      ...prev,
      [sessionId]: {
        ...current,
        transcriptStatus: 'loading',
        transcriptError: null,
      },
    }
  })

  try {
    const [chunk, worktreesResult] = await Promise.all([
      window.api.loadInitialHistory({
        kind,
        cwd: meta.cwd,
        providerSessionId: meta.providerSessionId,
        limit,
      }),
      window.api.gitWorktrees(meta.cwd),
    ])
    const worktrees = worktreesResult.ok ? worktreesResult.worktrees : []

    setRuntimes(prev => {
      const current = prev[sessionId]
      if (!current) return prev
      const seen = (refs.seenUuidsRef.current[sessionId] ??= new Set())
      seedSeenFromRuntime(current, seen)

      const initialEntries: Entry[] = []
      let initialOldestMarker: string | null = null
      let workActivity = current.workActivity
      let workContext = current.workContext
      let codexTurnId: string | null = null
      const toolUseIndex = current.toolUseIndex
      const toolResultIndex = current.toolResultIndex

      for (const raw of chunk.entries) {
        workActivity = ingestWorktreeRawEvent({
          state: workActivity,
          raw,
          worktrees,
          sessionCwd: meta.cwd,
        })
        workContext = deriveAgentWorkContext(workActivity)

        if (kind === 'codex') {
          const marker = codexHistoryMarker(raw)
          const turnContextId = codexTurnIdFromRollout(raw)
          if (turnContextId !== null) codexTurnId = turnContextId
          const payloadTurnId = codexTurnIdFromEventPayload(raw)
          if (payloadTurnId !== null) codexTurnId = payloadTurnId
          const mappedRaw = mapCodexRolloutToFeedEntries(raw)
          const mapped = mappedRaw.map(entry => stampCodexTurnId(entry, codexTurnId))
          if (mapped.length > 0 && !initialOldestMarker) initialOldestMarker = marker
          for (const entry of mapped) {
            const uuid = (entry as { uuid?: string }).uuid
            if (uuid && seen.has(uuid)) continue
            if (uuid) seen.add(uuid)
            initialEntries.push(entry)
            indexEntryIntoMaps(entry, toolUseIndex, toolResultIndex)
          }
          const eventType = codexEventType(raw)
          if (
            eventType === 'task_complete' ||
            eventType === 'turn_complete' ||
            eventType === 'turn_aborted'
          ) {
            codexTurnId = null
          }
          continue
        }

        const feedEntry =
          extractEmbeddedClaudeProgressEntry(raw) ??
          (raw as Entry)
        const marker = claudeHistoryMarker(raw)
        if (
          !isConversationEntry(feedEntry) &&
          !isCompactBoundaryEntry(feedEntry) &&
          !isCompactSummaryEntry(feedEntry)
        ) {
          continue
        }
        if (marker && !initialOldestMarker) initialOldestMarker = marker
        const uuid = (feedEntry as { uuid?: string }).uuid
        if (uuid && seen.has(uuid)) continue
        if (uuid) seen.add(uuid)
        initialEntries.push(feedEntry)
        indexEntryIntoMaps(feedEntry, toolUseIndex, toolResultIndex)
      }

      let nextGhosts = current.ghosts
      for (const entry of initialEntries) {
        nextGhosts = reconcileUpstream(entry, nextGhosts)
      }
      for (const ghost of ghostsToPersist(current.ghosts, nextGhosts)) {
        window.api.ghostAppend(sessionId, ghost)
      }

      // Bootstrap-load equivalent of the live-ingest stamping in
      // useIpcSubscriptions.ts. selectMergedEntries gates orphan
      // ghost rendering against this timestamp; on resume we need
      // it primed from the loaded JSONL tail so a ghost from the
      // previous session whose updatedAt is older than the freshest
      // loaded JSONL entry stays correctly hidden, while a ghost
      // newer than every loaded entry (the
      // "JSONL-stopped-mid-turn before the previous run died" case)
      // surfaces as expected.
      let lastJsonlEntryAt = current.lastJsonlEntryAt
      for (const entry of initialEntries) {
        const ts = (entry as { timestamp?: unknown }).timestamp
        if (typeof ts !== 'string') continue
        const ms = Date.parse(ts)
        if (!Number.isFinite(ms)) continue
        if (lastJsonlEntryAt === null || ms > lastJsonlEntryAt) {
          lastJsonlEntryAt = ms
        }
      }

      const nextRuntime = appendFeedDebugLog(
        {
          ...current,
          entries: initialEntries.length > 0
            ? [...initialEntries, ...current.entries]
            : current.entries,
          historyOldestMarker: initialOldestMarker ?? current.historyOldestMarker,
          hasOlderHistory: chunk.hasMore,
          transcriptStatus: 'ready',
          transcriptError: null,
          workActivity,
          workContext,
          toolUseIndex,
          toolResultIndex,
          ghosts: nextGhosts,
          lastJsonlEntryAt,
        },
        {
          layer: 'STATE',
          kind: 'initial_history',
          summary: `initial history +${initialEntries.length}`,
          data: {
            rawEntries: chunk.entries.length,
            mappedEntries: initialEntries.length,
            hasMore: chunk.hasMore,
          },
        },
      )

      return { ...prev, [sessionId]: nextRuntime }
    })

    span.end({
      fetched: chunk.entries.length,
      hasMore: chunk.hasMore,
    })
  } catch (err) {
    span.fail(err)
    const message = err instanceof Error ? err.message : String(err)
    console.warn('[history] load initial failed', err)
    setRuntimes(prev => {
      const current = prev[sessionId]
      if (!current) return prev
      return {
        ...prev,
        [sessionId]: {
          ...current,
          transcriptStatus: 'error',
          transcriptError: message,
        },
      }
    })
  }
}
