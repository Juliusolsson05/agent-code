import { useAppStore } from '@renderer/app-state/hooks'
import { colorFlagById, type ColorFlag } from '@renderer/app-state/settings/dispatchColorFlags'
import type { SessionId } from '@renderer/workspace/types'

/**
 * Resolve a session's color flag, or `undefined` when it has none.
 *
 * WHY this is a hook and not each surface selecting inline: color flags now
 * have more than one reader (the Dispatch trailing column and the pane header
 * chunk), and the thing that must NEVER fork between them is the state
 * question — which settings key is read, and how an unknown/stale persisted id
 * degrades. Geometry deliberately stays with each surface, because a 10px
 * alignment column and a 25% header chunk are different visual contracts that
 * should be free to diverge.
 *
 * Returning the resolved `ColorFlag` rather than the raw id means every caller
 * gets the same "unknown id → no flag" degradation for free: a palette entry
 * deleted in a future version stops rendering everywhere at once instead of
 * throwing at one call site and rendering `undefined` at another.
 */
export function useColorFlag(sessionId: SessionId): ColorFlag | undefined {
  return useAppStore(state => colorFlagById(state.settings.dispatchColorFlags[sessionId]))
}
