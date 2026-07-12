import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import { useCallback } from 'react'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId } from '@renderer/workspace/types'
import type { Entry } from '@shared/types/transcript'
import { indexEntryIntoMaps } from '@renderer/session-runtime/entries'
import {
  isUuidTrimmed,
  noteOlderHistoryPrepend,
  releaseTrimmedUuid,
  stampHistoryMarker,
} from '@renderer/session-runtime/liveEntryWindow'
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
            // ASYMMETRIC dedupe (#375 part B): a uuid the live window
            // TRIMMED is still in `seen` (it must never re-append at the
            // tail via a live replay burst), but this older-history path
            // is exactly how trimmed entries come back — in order, at the
            // head. So trimmed membership OVERRIDES seen here, and the
            // uuid leaves the trimmed set as it reloads (it is back in
            // the window and re-enters the trim cycle normally).
            if (uuid && seen.has(uuid) && !isUuidTrimmed(sessionId, uuid)) continue
            if (uuid) {
              seen.add(uuid)
              releaseTrimmedUuid(sessionId, uuid)
            }
            // Same rider the live/bootstrap sites stamp — a reloaded entry
            // must be re-trimmable later, which needs its marker back.
            stampHistoryMarker(entry, marker)
            prepend.push(entry)
          }
        }

        // Suspend live-window trimming for a grace period: the user just
        // paged history in and is reading the TOP of the window — the exact
        // rows a trim would remove, with no shrink-anchoring in Feed to
        // keep their scroll position. See liveEntryWindow.ts for the WHY.
        if (prepend.length > 0) noteOlderHistoryPrepend(sessionId)

        setRuntimes(prev => {
          const current = prev[sessionId] ?? emptyRuntime()
          // Fold the paged-in entries' tool blocks into the live indices.
          // This was a latent gap (pagination never indexed, so a paged-in
          // tool_result row couldn't resolve its command cross-entry) that
          // became LOAD-BEARING with the live window: a trim rebuilds the
          // indices from retained entries only, so reloading the trimmed
          // region MUST restore its pairings or the reloaded rows would
          // paint permanently degraded. Same in-place-mutate + version-bump
          // contract as the ingest sites (see entries.ts).
          //
          // INTENTIONAL BEHAVIOR CHANGE for never-trimmed sessions too
          // (evaluated for the #511 review, kept deliberately): scroll-back
          // in an ordinary session now also indexes what it pages in, so
          // rows that previously painted the degraded generic fallback
          // (Read/Edit/TodoWrite/git/AskUserQuestion cards missing their
          // source-tool metadata) now render rich. Gating this to post-trim
          // sessions would preserve a bug purely for behavioral stasis.
          // Why it can't regress anything else: tool_use ids are
          // provider-generated and unique within a session, so an old
          // paged-in block can never collide with (and overwrite) a live
          // pairing — the only same-id re-index is the reloaded-trimmed-
          // region case, where re-pointing to the equivalent reloaded block
          // is exactly the intent. And the toolIndexVersion bump rides a
          // state update that already replaces the entries array reference,
          // so Feed re-renders exactly once either way — the bump changes
          // what the mounted tool rows can RESOLVE, not how often they
          // paint.
          let toolIndexChanged = false
          for (const entry of prepend) {
            if (indexEntryIntoMaps(entry, current.toolUseIndex, current.toolResultIndex)) {
              toolIndexChanged = true
            }
          }
          return {
            ...prev,
            [sessionId]: {
              ...current,
              entries: prepend.length > 0 ? [...prepend, ...current.entries] : current.entries,
              toolIndexVersion: toolIndexChanged
                ? current.toolIndexVersion + 1
                : current.toolIndexVersion,
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
