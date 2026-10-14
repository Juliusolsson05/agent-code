import type { PersistedWindow } from '@main/storage/workspaceFile.js'
import type { WorkspaceFileStore } from '@main/storage/workspaceFileStore.js'
import { EMPTY_PERSISTED_SIDEKICKS } from '@shared/sidekicks/types.js'
import type { PersistedSidekicks } from '@shared/sidekicks/types.js'

/**
 * A `WorkspaceFileStore` that hands out prepared saves on demand.
 *
 * WHY this is shared rather than copied into each projection test: the real
 * store's contract is that it notifies observers ONLY after bytes reach disk,
 * in commit order. Two copies of that fake would drift, and the copy that
 * drifted would be the one asserting the freshness contract — which is the
 * whole reason `RemoteWorkspaceProjection` is allowed to be one save behind
 * the renderer rather than reading live state.
 *
 * `commitNext()` advances to the next prepared document and notifies, exactly
 * as a committed autosave does.
 */
export function fakeWorkspaceFileStore(saves: readonly (readonly PersistedWindow[])[]) {
  let windows: readonly PersistedWindow[] = saves[0] ?? []
  let cursor = 1
  const observers = new Set<(next: readonly PersistedWindow[], sidekicks: PersistedSidekicks) => void>()
  return {
    windows: () => windows,
    // The real store's second document section (#1493). These saves carry no
    // sidekicks, so the fake reports the same empty index the real store does.
    sidekicks: () => EMPTY_PERSISTED_SIDEKICKS,
    observe(listener: (next: readonly PersistedWindow[], sidekicks: PersistedSidekicks) => void) {
      observers.add(listener)
      return () => observers.delete(listener)
    },
    commitNext() {
      windows = saves[cursor] ?? windows
      cursor += 1
      for (const observer of observers) observer(windows, EMPTY_PERSISTED_SIDEKICKS)
    },
    /** The projection takes the real interface; the fake is structural. */
    asStore(): WorkspaceFileStore {
      return this as unknown as WorkspaceFileStore
    },
  }
}
