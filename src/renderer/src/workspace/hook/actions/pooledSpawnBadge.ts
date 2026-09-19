import { emptyRuntime } from '@renderer/session-runtime/state'
import type { WorkspaceSetRuntimes } from '@renderer/workspace/hook/context'
import type { SessionId } from '@renderer/workspace/types'

// The "new" chip on an index row (#992 §4.3), both halves in one place.
//
// Under context-places, a spawn from an occupied lane, the palette, ⌘N, ⌘T,
// MCP or orchestration moves nothing on screen. A spawn that cost a real
// backend boot would then look exactly like a command that did nothing. The
// index row wears a small "new" chip (SessionRuntime.pooledSpawnAt) until the
// session is placed into any lane, so "where did my agent go?" is answered by
// the next thing the user was going to look at anyway.
//
// WHY one module for both halves (#1013 review B): the mark lived in pane.ts
// and the clear in dispatch.ts's setTiledLaneSession, with a comment claiming
// every placement funnels through there. Label navigation, agents.show,
// views.agentSet, Agent Activity's Focus and the Performance Monitor all
// place through agentIndexNavigation instead, so the chip stayed on an agent
// that was on screen for the rest of the run. ⌘T, for its part, never marked
// at all. Every placement or spawn site now imports the same two functions.

/** Badge a session that landed in the pool. The "guard the row exists" dance
 *  (`prev[id] ?? emptyRuntime()`) is exactly the kind of thing one site gets
 *  subtly wrong, and a spawn whose badge write throws would report a creation
 *  failure after the backend already booted. */
export function markPooledSpawn(setRuntimes: WorkspaceSetRuntimes, sessionId: SessionId): void {
  setRuntimes(prev => {
    const runtime = prev[sessionId] ?? emptyRuntime()
    return { ...prev, [sessionId]: { ...runtime, pooledSpawnAt: Date.now() } }
  })
}

/** Placing a session into a lane is the user answering the badge. Returns the
 *  same map when there is nothing to clear, so it costs no render. */
export function clearPooledSpawnBadge(setRuntimes: WorkspaceSetRuntimes, sessionId: SessionId): void {
  setRuntimes(prev => {
    const runtime = prev[sessionId]
    if (!runtime?.pooledSpawnAt) return prev
    return { ...prev, [sessionId]: { ...runtime, pooledSpawnAt: null } }
  })
}
