import { rendererOperations } from '@renderer/performance/monitorOperations'
import { useCallback, useEffect, useRef } from 'react'

import type { PersistedWorkspace } from '@renderer/workspace/persistence'
import type { SessionId, WorkspaceState } from '@renderer/workspace/types'
import { pruneSessionOwnership } from '@renderer/workspace/sessionOwnership'
import { withNormalizedBuiltInMcpDomains } from '@renderer/workspace/mcpDomains'
import { isAgentSessionKind } from '@shared/types/providerKind'

import type { WorkspaceRefs } from '@renderer/workspace/hook/refs'
import * as perf from '@renderer/performance/client'

const AUTOSAVE_DELAY_MS = 400
const AUTOSAVE_RETRY_MAX_DELAY_MS = 30_000

// Debounced workspace-save + beforeunload flush.
//
// The save is extracted into a stable helper so it can be called
// both from the debounce timer AND from the beforeunload flush. We
// keep a ref to the latest state so the beforeunload handler (which
// can't close over React state) always serializes the freshest
// version.
//
// The debounced save has a 400ms window where a mutation hasn't
// been written yet. If the user quits the app during that window,
// the latest state is lost — tabs vanish, sessions can't resume.
//
// Fix: listen for `beforeunload` (fires synchronously before the
// renderer is torn down) and flush immediately. The IPC invoke is
// async but Electron's main process receives the message before the
// window actually closes — the write lands. Same pattern VS Code
// uses for its workspace state.
//
// Autosave is intentionally disabled until bootstrap finishes. The
// hook mounts before persisted sessions are respawned, and saving the
// initial empty Zustand state during that window can overwrite a real
// workspace.json with `tabs: []` or a partially restored layout.

/** Consecutive failed saves before the user is told (the first retries are
 *  usually enough for a transient error). */
export const SAVE_FAILURE_BANNER_AFTER = 3

/** What the banner says about a failed save: the storage error itself,
 *  without Electron's IPC wrapper ("Error invoking remote method ..."),
 *  which names an internal channel rather than the problem. */
export function saveFailureText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

export function useAutoSave(
  state: WorkspaceState,
  draftVersion: number,
  refs: WorkspaceRefs,
  bootstrapComplete: boolean,
  // Told the save failure to show (null when saves work again). #1244.
  onSaveHealth: (failure: string | null) => void = () => undefined,
): void {
  const onSaveHealthRef = useRef(onSaveHealth)
  onSaveHealthRef.current = onSaveHealth
  const retryEnabledRef = useRef(false)
  const retryAttemptRef = useRef(0)
  // Consecutive REJECTED saves, reset only by a successful save (#1263
  // review). retryAttemptRef is the backoff position and is reset by every
  // edit, so counting with it meant a user who kept typing on a full disk
  // (the #1244 case exactly) never reached the threshold.
  const failedSavesRef = useRef(0)
  const flushSaveRef = useRef<() => void>(() => undefined)
  const flushSave = useCallback(() => {
    const saveSpan = perf.span('workspace.autosave.flush')
    const s = refs.latestStateRef.current
    const pruned = pruneSessionOwnership(s)
    if (pruned.droppedSessionIds.length > 0) {
      // WHY autosave prunes instead of faithfully serializing runtime state:
      //
      // Autosave is the durability boundary. If an action accidentally leaves
      // an unowned row in `state.sessions`, writing it to workspace.json turns a
      // transient invariant violation into a startup respawn on every future
      // launch. Pruning here is the last line of defense: parked sessions still
      // persist, but metadata with no owner cannot make itself durable.
      //
      // "No owner" means the row's `projectId` names no project. That is also
      // what a session looks like if some writer forgot to FILE it
      // (fileSessionInProject), in which case this warning is the only trace
      // of a session that will be gone after restart — treat it as a bug
      // report, not as housekeeping.
      // eslint-disable-next-line no-console
      console.warn('[workspace] dropping unowned sessions during autosave:', pruned.droppedSessionIds)
    }
    // (A `repairPersistedTabs` pass ran here until #992. Tile trees were an
    // ownership surface written verbatim, so a leaf whose metadata was already
    // gone could become durable — and rehydrate, counting it as a pane it must
    // restore and never could, reported `partial-restore` and held autosave off
    // on every later launch. Since autosave is the only writer of
    // workspace.json, the file could then never be repaired by the app. With
    // ownership on the row, an orphan is an unowned row and the prune above
    // already dropped it; there is no second structure to cut it out of.)

    // Collect non-empty drafts so in-progress prompts survive crashes. Only agent
    // panes own a composer. Extension panes stay in `pruned.sessions` so their
    // metadata persists, which let any path that wrote an invisible draft into
    // one (Key Vault insertion did) make that text — a secret — durable in
    // workspace.json with no UI to see or clear it.
    const drafts: Record<SessionId, string> = {}
    for (const [id, rt] of Object.entries(refs.latestRuntimesRef.current)) {
      if (pruned.sessions[id] && isAgentSessionKind(pruned.sessions[id].kind) && rt.draftInput) drafts[id] = rt.draftInput
    }
    // Filter pins against the pruned `sessions` map so a stale entry
    // (kill-races, hand-edited workspace.json, mid-rehydrate
    // inconsistency) cannot make itself durable. Same "autosave is
    // the last line of defense" reasoning as the
    // pruneSessionOwnership call above — better to lose a pin than
    // to boot the next launch with a phantom row that points at
    // nothing.
    const persistedPinnedSessionIds = s.pinnedSessionIds.filter(
      id => pruned.sessions[id] !== undefined,
    )
    // v3 ONLY (#992). Nothing of the v2 shape is written any more: no `tabs`
    // with tile trees, no `detachedSessions`, no `buried`, no `dispatchMode`.
    // An older build opening this file finds no `tabs`, fails its rehydrate and
    // lands in its recovery path with autosave LOCKED — it cannot show the
    // workspace, and it cannot overwrite it either (see PersistedWorkspace).
    //
    // A project that no longer holds a session is not written. It owns nothing
    // (U4), and reading one back would give a header over an empty list.
    const populatedProjectIds = new Set<string>()
    for (const meta of Object.values(pruned.sessions)) {
      if (meta.projectId !== undefined) populatedProjectIds.add(meta.projectId)
    }
    const projects = s.tabs
      .filter(tab => populatedProjectIds.has(tab.id))
      .map(tab => ({ id: tab.id, title: tab.title }))
    const persisted: PersistedWorkspace = {
      projects,
      activeProjectId: projects.some(project => project.id === s.activeTabId)
        ? s.activeTabId
        : (projects[0]?.id ?? ''),
      // The lane grid, scrubbed against the same live ids as the pool: what is
      // in memory is what is written. (Through stage 2 of #992 this was
      // DERIVED at save time from the v2 half; a derivation at the durability
      // boundary would overwrite the user's lanes with a guess on every save.)
      stage: pruned.stage,
      // WHY normalize MCP domains at the persistence boundary:
      //
      // The provider process only receives short-lived MCP URLs/tokens, but
      // the renderer owns the durable domain names that should be re-enabled
      // for this agent on reload. Normalizing here makes workspace.json a
      // stable contract: duplicate domains, hand-edited junk, or removed
      // experimental names cannot become durable state that future launches
      // keep trying to inject.
      //
      // Every row already carries its pool membership (`projectId`,
      // `joinedAt`) — it is ordinary SessionMeta, stamped when the session was
      // filed, so there is nothing to derive here.
      sessions: Object.fromEntries(
        Object.entries(pruned.sessions).map(([id, meta]) => [
          id,
          withNormalizedBuiltInMcpDomains(meta),
        ]),
      ),
      pinnedSessionIds: persistedPinnedSessionIds.length > 0
        ? persistedPinnedSessionIds
        : undefined,
      drafts: Object.keys(drafts).length > 0 ? drafts : undefined,
    }
    let json = ''
    const finishSerialize = rendererOperations.begin('persistence.serialize')
    try {
      json = JSON.stringify({ workspace: persisted }, null, 2)
      finishSerialize()
    } catch (err) {
      finishSerialize('error')
      saveSpan.fail(err)
      throw err
    }
    void window.api.saveWorkspace(json)
      .then(() => {
        retryAttemptRef.current = 0
        failedSavesRef.current = 0
        onSaveHealthRef.current(null)
        // Drain any adopted-window confirmations now that the merged rows are
        // DURABLE. Main deletes the closed window's slice on this call, so it
        // has to follow a committed save rather than the in-memory merge — see
        // `pendingAdoptionWindowIdsRef`. Draining before the confirmations
        // resolve is deliberate: a failed confirm leaves main's slice in place,
        // which is the safe direction, and re-queuing would risk an unbounded
        // retry loop against a read-only store.
        const pendingAdoptions = refs.pendingAdoptionWindowIdsRef.current
        if (pendingAdoptions.length > 0) {
          refs.pendingAdoptionWindowIdsRef.current = []
          for (const windowId of pendingAdoptions) {
            void window.api.confirmWorkspaceAdoption(windowId).catch(err => {
              // eslint-disable-next-line no-console
              console.warn('[workspace] adoption confirmation failed:', err)
            })
          }
        }
        saveSpan.end({
          tabs: projects.length,
          sessions: Object.keys(persisted.sessions).length,
          bytes: json.length,
        })
      })
      .catch(err => {
        saveSpan.fail(err, { bytes: json.length })
        // eslint-disable-next-line no-console
        console.warn('[workspace] save failed:', err)
        // WHY a banner after a few failures and not only this warn (#1244):
        // a full disk or a permission change makes every save fail, the
        // backoff below retries forever, and the user keeps working on
        // changes that are lost at quit. One failure is often transient (the
        // retry fixes it silently); SAVE_FAILURE_BANNER_AFTER in a row is a
        // condition the user must know about.
        failedSavesRef.current += 1
        if (failedSavesRef.current >= SAVE_FAILURE_BANNER_AFTER) {
          onSaveHealthRef.current(saveFailureText(err))
        }
        if (
          retryEnabledRef.current &&
          refs.saveTimerRef.current === null
        ) {
          // WHY persistence failure owns its own retry: a successful Codex
          // replacement remains main-owned until this save acknowledges its
          // successor ID. Requiring an unrelated UI mutation to schedule the
          // next debounce leaves both ownership and a queued second reload
          // blocked forever after one transient filesystem error. Re-entering
          // flushSave through a ref serializes the latest state, not the stale
          // JSON captured by the failed attempt.
          const retryDelayMs = Math.min(
            AUTOSAVE_DELAY_MS * (2 ** retryAttemptRef.current),
            AUTOSAVE_RETRY_MAX_DELAY_MS,
          )
          retryAttemptRef.current += 1
          refs.saveTimerRef.current = setTimeout(() => {
            refs.saveTimerRef.current = null
            flushSaveRef.current()
          }, retryDelayMs)
        }
      })
  }, [
    refs.latestRuntimesRef,
    refs.latestStateRef,
    refs.pendingAdoptionWindowIdsRef,
  ])

  // The retry callback must always execute the newest serializer closure, but
  // adding flushSave to its own dependency graph would make the callback
  // recursive at construction time. A ref expresses the real invariant: one
  // timer may call the latest committed render's flush implementation.
  flushSaveRef.current = flushSave

  useEffect(() => {
    retryEnabledRef.current = bootstrapComplete
    return () => {
      retryEnabledRef.current = false
    }
  }, [bootstrapComplete])

  useEffect(() => () => {
    // WHY this cleanup is not tied to the timer captured by the state effect:
    // that original debounce may already have fired and installed a later
    // retry. Unmount is the actual renderer-generation boundary and must cancel
    // whichever timer the generation owns at that instant.
    if (refs.saveTimerRef.current) {
      clearTimeout(refs.saveTimerRef.current)
      refs.saveTimerRef.current = null
    }
  }, [refs.saveTimerRef])

  useEffect(() => {
    if (!bootstrapComplete) return
    // A newer state is a fresh durability attempt, not another failure of the
    // same bytes. Reset backoff so user progress is persisted promptly.
    retryAttemptRef.current = 0
    if (refs.saveTimerRef.current) clearTimeout(refs.saveTimerRef.current)
    const timer = setTimeout(() => {
      refs.saveTimerRef.current = null
      flushSave()
    }, AUTOSAVE_DELAY_MS)
    refs.saveTimerRef.current = timer
    return () => {
      if (refs.saveTimerRef.current === timer) {
        clearTimeout(timer)
        refs.saveTimerRef.current = null
      }
    }
  }, [state, draftVersion, flushSave, refs.saveTimerRef, bootstrapComplete])

  useEffect(() => {
    const onBeforeUnload = () => {
      if (!bootstrapComplete) return
      // Cancel the debounced timer so we don't double-save.
      if (refs.saveTimerRef.current) {
        clearTimeout(refs.saveTimerRef.current)
        refs.saveTimerRef.current = null
      }
      // beforeunload is vetoable (for example, the editor's unsaved-changes
      // guard). It is only an attempted teardown, so this flush must remain
      // retry-capable if the renderer survives. Actual unmount flips the
      // generation flag and cancels whichever retry timer is then current.
      retryAttemptRef.current = 0
      flushSave()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [flushSave, refs.saveTimerRef, bootstrapComplete])
}
