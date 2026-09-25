import { DEFAULT_PROVIDER, isAgentProviderKind } from '@shared/types/providerKind'
import { useCallback } from 'react'

import { emptyRuntime } from '@renderer/session-runtime/state'
import type { SessionRuntime } from '@renderer/session-runtime/state'
import type { SessionId } from '@renderer/workspace/types'
import type { Entry } from '@shared/types/transcript'
import {
  admitMappedEntries,
  isPaginationAnchor,
  reindexToolsAfterMerge,
  type CommittedSeenLedger,
} from '@renderer/session-runtime/ingest/committedRecords'
import {
  isUuidTrimmed,
  noteOlderHistoryPrepend,
  releaseTrimmedUuid,
} from '@renderer/session-runtime/liveEntryWindow'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import {
  deriveAgentWorkContext,
  ingestWorktreeRawEvent,
} from '@shared/work-context/tracker'

import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'
import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import * as perf from '@renderer/performance/client'
import type { SessionFeed } from '@shared/sessionFeed/SessionFeed'

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
  // The SessionFeed the workspace mounted (#1177): older pages are read through
  // the contract, like every other session read, instead of `window.api`.
  // Required here, unlike the initial loader's default, because this is a hook
  // and its one caller already holds the feed from context.
  feed: Pick<SessionFeed, 'loadHistory'>,
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
      // No providerRuntime check: a terminal-runtime pane never mounts the
      // Feed that pages, but its runtime holds the same durable history as
      // any agent's (see loadInitialHistoryForSession), so a caller that
      // does page it gets the same answer.
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
        const chunk = await feed.loadHistory({
          sessionId,
          transcript: { kind, cwd: meta.cwd, providerSessionId: meta.providerSessionId },
          beforeMarker: runtime.historyOldestMarker,
          // The byte position of that marker's line when we have it — the
          // loader anchors exactly there instead of hunting the marker,
          // which is what keeps paging exact and terminating when markers
          // repeat (see historyLoader.ts). Absent → marker-only fallback.
          beforeOffset: runtime.historyOldestOffset ?? undefined,
          limit: 200,
        })

        const seen = (refs.seenUuidsRef.current[sessionId] ??= new Set())
        const seenLedger: CommittedSeenLedger = {
          seen,
          isTrimmed: uuid => isUuidTrimmed(sessionId, uuid),
          releaseTrimmed: uuid => releaseTrimmedUuid(sessionId, uuid),
        }
        const prepend: Entry[] = []
        const worktreesResult = await window.api.gitWorktrees(meta.cwd)
        const worktrees = worktreesResult.ok ? worktreesResult.worktrees : []
        let workActivity = runtime.workActivity
        let workContext = runtime.workContext
        let oldestMarker: string | null = runtime.historyOldestMarker
        let oldestOffset: number | null = runtime.historyOldestOffset
        let cursorSelected = false
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

        for (const [rawIndex, rawEntry] of chunk.entries.entries()) {
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
          // WHY selection needs its own latch: markers are not unique. The
          // first older record may have the SAME marker as the current anchor,
          // at an earlier byte position. Marker equality would leave selection
          // armed and let a later record move the cursor forward within this
          // page, or prevent its offset from advancing at all on commit.
          if (!cursorSelected && isPaginationAnchor(mapped, marker)) {
            cursorSelected = true
            oldestMarker = marker
            // The offset of THIS raw line, not the chunk's first: the
            // cursor is the first kept line, and leading records the
            // mapper drops (Codex turn_context, Claude snapshots) would
            // otherwise make the loader's marker-at-offset check fail and
            // silently degrade every page to the slow scan.
            oldestOffset = chunk.offsets?.[rawIndex] ?? null
          }
          // ASYMMETRIC dedupe (#375 part B), the `older` rule in
          // session-runtime/ingest/committedRecords.ts: a uuid the live window
          // TRIMMED is still in `seen` (it must never re-append at the tail via
          // a live replay burst), but this older-history path is exactly how
          // trimmed entries come back — in order, at the head. So trimmed
          // membership OVERRIDES seen here, and the uuid leaves the trimmed
          // set as it reloads (it is back in the window and re-enters the trim
          // cycle normally). Reloaded entries get their marker rider back so
          // they are re-trimmable later. Indexing happens once below, against
          // the committed window.
          prepend.push(...admitMappedEntries(mapped, marker, 'older', seenLedger).admitted)
        }

        // Suspend live-window trimming for a grace period: the user just
        // paged history in and is reading the TOP of the window — the exact
        // rows a trim would remove, with no shrink-anchoring in Feed to
        // keep their scroll position. See liveEntryWindow.ts for the WHY.
        if (prepend.length > 0) noteOlderHistoryPrepend(sessionId)

        setRuntimes(prev => {
          const current = prev[sessionId] ?? emptyRuntime()
          const entries = prepend.length > 0 ? [...prepend, ...current.entries] : current.entries
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
          // source-tool metadata) now render rich.
          //
          // Since #1177 the fold REBUILDS the indexes in window order instead
          // of appending the page's blocks (reindexToolsAfterMerge explains
          // why; the phone already did this). The earlier argument that an
          // old block can never overwrite a live pairing assumed ids never
          // repeat; the rebuild is correct either way and identical when they
          // don't. A page with no tool block leaves the maps and the version
          // alone. The version bump rides a state update that already
          // replaces the entries array, so Feed re-renders exactly once either
          // way — it changes what mounted tool rows can RESOLVE, not how often
          // they paint.
          const toolIndexChanged = prepend.length > 0 && reindexToolsAfterMerge(prepend, entries, {
            toolUseIndex: current.toolUseIndex,
            toolResultIndex: current.toolResultIndex,
          })
          return {
            ...prev,
            [sessionId]: {
              ...current,
              entries,
              toolIndexVersion: toolIndexChanged
                ? current.toolIndexVersion + 1
                : current.toolIndexVersion,
              historyOldestMarker: oldestMarker ?? current.historyOldestMarker,
              // Commit the selected pair even when only the byte position
              // changed. Repeated marker strings still represent distinct
              // physical records; retaining the old offset re-requests a page.
              historyOldestOffset: cursorSelected
                ? oldestOffset
                : current.historyOldestOffset,
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
    [refs.latestRuntimesRef, refs.seenUuidsRef, refs.stateRef, setRuntimes, updateRuntime, feed],
  )

  return { loadOlderHistory }
}
