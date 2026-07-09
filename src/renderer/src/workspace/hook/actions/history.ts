import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import { useCallback } from 'react'

import { emptyRuntime, type SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId } from '@renderer/workspace/types'
import type { Entry } from '@shared/types/transcript'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import {
  deriveAgentWorkContext,
  ingestWorktreeRawEvent,
} from '@shared/work-context/tracker'

import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import * as perf from '@renderer/performance/client'

// Older history loader — called by Feed's scroll handler when the
// user scrolls near the top.
//
// Walks the rollout stream linearly; the rolling Codex turn id is
// maintained from both `turn_context` and payload-level `turn_id`
// markers so paged response_items get the same ownership metadata as
// entries that arrived live.

export function useHistoryActions(
  setRuntimes: WorkspaceSetRuntimes,
  refs: WorkspaceRefs,
  updateRuntime: (sessionId: SessionId, patch: Partial<SessionRuntime>) => void,
): {
  loadOlderHistory: (sessionId: SessionId) => Promise<void>
} {
  const loadOlderHistory = useCallback(
    async (sessionId: SessionId) => {
      const span = perf.span('workspace.history.loadOlder', { sessionId })
      const currentState = refs.stateRef.current
      const meta = currentState.sessions[sessionId]
      const runtime = refs.latestRuntimesRef.current[sessionId] ?? emptyRuntime()
      if (!meta) {
        span.end({ skipped: 'missing-meta' })
        return
      }

      const kind = meta.kind ?? DEFAULT_PROVIDER
      if (!isAgentProviderKind(kind) || !meta.providerSessionId) {
        span.end({ skipped: 'unsupported-or-missing-provider-session', kind })
        return
      }
      if (!runtime.hasOlderHistory || runtime.loadingOlderHistory) {
        span.end({
          skipped: runtime.loadingOlderHistory ? 'already-loading' : 'no-older-history',
          kind,
        })
        return
      }
      if (!runtime.historyOldestMarker) {
        updateRuntime(sessionId, { hasOlderHistory: false, loadingOlderHistory: false })
        span.end({ skipped: 'missing-marker', kind })
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
        const worktreesResult = await window.api.gitWorktrees(meta.cwd)
        const worktrees = worktreesResult.ok ? worktreesResult.worktrees : []
        let workActivity = runtime.workActivity
        let workContext = runtime.workContext
        let oldestMarker: string | null = runtime.historyOldestMarker
        // Registry-owned mapper (#394 phase 2b). Chunk-scoped: starts
        // with a null turn cursor, which for Codex means pagination
        // chunks that begin mid-turn rely on `payload.turn_id` — the
        // only durable source in many chunks (see the mapper's cursor
        // sequencing docs). Without stamping these older response
        // items, the live feed and paged history disagree about which
        // committed messages belong to the Codex task, and duplicate
        // suppression becomes dependent on where the scroll boundary
        // landed.
        const mapper = getRendererProviderCapabilities(kind).createTranscriptEntryMapper()

        for (const rawEntry of chunk.entries) {
          // Older-history pagination walks records that predate the current
          // tail. Use them only to backfill an unknown badge; never let old
          // worktree evidence replace fresher live/current context.
          if (!workContext) {
            workActivity = ingestWorktreeRawEvent({
              state: workActivity,
              raw: rawEntry,
              worktrees,
              sessionCwd: meta.cwd,
            })
            workContext = deriveAgentWorkContext(workActivity)
          }

          const { entries: mapped, historyMarker: marker } = mapper.map(rawEntry)
          // Marker policy (site-owned): only the FIRST kept line of the
          // chunk replaces the pagination cursor — `oldestMarker` must
          // stay pinned to where the NEXT older page should start.
          if (mapped.length > 0 && marker && oldestMarker === runtime.historyOldestMarker) {
            oldestMarker = marker
          }
          for (const entry of mapped) {
            const uuid = (entry as { uuid?: string }).uuid
            if (uuid && seen.has(uuid)) continue
            if (uuid) seen.add(uuid)
            prepend.push(entry)
          }
        }

        setRuntimes(prev => {
          const current = prev[sessionId] ?? emptyRuntime()
          return {
            ...prev,
            [sessionId]: {
              ...current,
              entries: prepend.length > 0 ? [...prepend, ...current.entries] : current.entries,
              historyOldestMarker: oldestMarker ?? current.historyOldestMarker,
              // Trust `chunk.hasMore` as the authoritative "is there
              // more history to fetch" signal. The old rule OR'd in
              // `prepend.length === 0` — i.e. "re-enable loading
              // when nothing renderable came back" — which loops
              // forever when the loader legitimately returns a tail
              // chunk whose entries are all non-renderable Codex
              // metadata (turn_context, session_meta, event_msg
              // variants the mapper drops). Those chunks have
              // `hasMore: false`; honoring that ends the pagination
              // even when `prepend.length === 0`. If a chunk with
              // `hasMore: true` produces zero renderable entries,
              // we still fall through with hasOlderHistory=true and
              // the user can request the next chunk manually.
              hasOlderHistory: chunk.hasMore,
              loadingOlderHistory: false,
              workContext,
              workActivity,
            },
          }
        })
        span.end({
          kind,
          fetched: chunk.entries.length,
          prepended: prepend.length,
          hasMore: chunk.hasMore,
        })
      } catch (err) {
        span.fail(err, { kind })
        console.warn('[history] load older failed', err)
        updateRuntime(sessionId, { loadingOlderHistory: false })
      }
    },
    [refs.latestRuntimesRef, refs.seenUuidsRef, refs.stateRef, setRuntimes, updateRuntime],
  )

  return { loadOlderHistory }
}
