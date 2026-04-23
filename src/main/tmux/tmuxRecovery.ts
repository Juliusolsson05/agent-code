// On-launch reconciliation between persisted workspace state and the
// tmux server's view of the world.
//
// Three buckets:
//   - alive + known   → re-attach (don't respawn)
//   - alive + orphan  → P1: kill (no UI yet to surface them; P2 adds
//                       the undo tray which doubles as recovery surface)
//   - dead  + known   → P1: respawn from scratch (lost state)
//
// We do NOT touch sessions outside our prefix — those belong to the
// user and are none of our business.

import type { TmuxRegistry } from '@main/tmux/TmuxRegistry.js'

export type PersistedTerminalRef = {
  sessionId: string
  tmuxName: string
}

export type RecoveryReport = {
  /** tmuxName values that were alive and matched a persisted ref —
   *  caller should re-attach instead of respawning. */
  recoverable: PersistedTerminalRef[]
  /** Persisted sessionIds whose tmuxName was NOT alive — caller
   *  should treat these as fresh spawns. */
  lost: string[]
  /** Alive ccshell-* sessions that were NOT in persisted state.
   *  P1 kills these silently; P2 will route them to the undo tray. */
  orphans: string[]
}

export async function reconcile(
  registry: TmuxRegistry,
  persisted: PersistedTerminalRef[],
): Promise<RecoveryReport> {
  if (!registry.isAvailable()) {
    // No tmux means no recovery is possible — every persisted ref
    // is "lost" by definition (caller will treat as fresh spawn).
    return { recoverable: [], lost: persisted.map(p => p.sessionId), orphans: [] }
  }

  const aliveSessions = await registry.listManagedSessions()
  const aliveNames = new Set(aliveSessions.map(s => s.name))
  const persistedNames = new Set(persisted.map(p => p.tmuxName))

  const recoverable = persisted.filter(p => aliveNames.has(p.tmuxName))
  const lost = persisted
    .filter(p => !aliveNames.has(p.tmuxName))
    .map(p => p.sessionId)
  const orphans = aliveSessions
    .filter(s => !persistedNames.has(s.name))
    .map(s => s.name)

  // P1: silently kill orphans. They're stale ccshell sessions from
  // a previous run that failed to clean up. The registry's prefix
  // guarantees these are ours to kill.
  for (const name of orphans) {
    await registry.killSession(name)
  }

  return { recoverable, lost, orphans }
}
