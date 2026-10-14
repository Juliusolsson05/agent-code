import { useEffect } from 'react'

import { useAppStore } from '@renderer/app-state/store'
import type { SessionMeta } from '@renderer/workspace/types'

// Keeps main's Sidekick record current for every sidekick row this window
// holds (#1493) — the sidekick counterpart of the workspace autosave, which
// deliberately never writes a sidekick row (plan I1).
//
// WHAT flows through it: provider identity (Claude's committed session id,
// Hermes' conversation after `/new`), the agent name the reconciler claims,
// title, MCP choices, a replacement's NEW local session id after Reload Agent
// or a provider switch, and the composer draft. Each of these is written into
// the row by the ordinary workspace code; this hook only notices and saves.
// Main accepts a save only from the window holding the session (I3), so a
// window that just lost the sidekick cannot overwrite the new holder.
//
// WHY "schedule only if none is pending" instead of a classic debounce: the
// store changes on every streamed token. A debounce that restarts on each
// change would never fire while an agent is talking — the window in which
// identity changes are most likely. This fires at most every SAVE_DELAY_MS.

const SAVE_DELAY_MS = 400

type Snapshot = { sessionId: string; meta: SessionMeta; draft: string }

function heldSidekicks(): Map<string, Snapshot> {
  const state = useAppStore.getState()
  const out = new Map<string, Snapshot>()
  for (const [sessionId, meta] of Object.entries(state.workspaceState.sessions)) {
    if (!meta.sidekickId) continue
    out.set(meta.sidekickId, { sessionId, meta, draft: state.workspaceRuntimes[sessionId]?.draftInput ?? '' })
  }
  return out
}

export function useSidekickPersistence(): void {
  useEffect(() => {
    const saved = new Map<string, Snapshot>()
    let timer: ReturnType<typeof setTimeout> | null = null

    const flush = () => {
      timer = null
      for (const [sidekickId, snapshot] of heldSidekicks()) {
        const previous = saved.get(sidekickId)
        if (previous && previous.meta === snapshot.meta && previous.sessionId === snapshot.sessionId && previous.draft === snapshot.draft) continue
        saved.set(sidekickId, snapshot)
        void window.api.saveSidekick({
          id: sidekickId,
          sessionId: snapshot.sessionId,
          meta: snapshot.meta,
          // An empty draft is sent on purpose: it is how main learns the
          // composer was cleared (SidekickService.save drops the field).
          draft: snapshot.draft,
        }).then(result => {
          // A refused save (moved away, or main lost the record) must be
          // retried on the next change rather than considered done.
          if (!result.ok && saved.get(sidekickId) === snapshot) saved.delete(sidekickId)
        }).catch(() => {
          if (saved.get(sidekickId) === snapshot) saved.delete(sidekickId)
        })
      }
      // A row released from this window is no longer ours to save.
      const held = heldSidekicks()
      for (const sidekickId of [...saved.keys()]) if (!held.has(sidekickId)) saved.delete(sidekickId)
    }

    const schedule = () => {
      if (timer !== null) return
      timer = setTimeout(flush, SAVE_DELAY_MS)
    }

    const unsubscribe = useAppStore.subscribe(schedule)
    // The autosave's reason, restated: a quit or reload must not lose the last
    // 400 ms (a draft, a just-captured provider id).
    window.addEventListener('beforeunload', flush)
    schedule()
    return () => {
      unsubscribe()
      window.removeEventListener('beforeunload', flush)
      if (timer !== null) clearTimeout(timer)
    }
  }, [])
}
