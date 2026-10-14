import { useAppStore } from '@renderer/app-state/hooks'
import type { WorkspaceState } from '@renderer/workspace/types'

/**
 * Whether Sidekick Spotlight is actually on screen (#1493 follow-up): the
 * flag is set, the panel is open, and Settings is not covering everything.
 *
 * WHY one predicate shared by App (which gives up <main>'s width), MainSurface
 * (which retains the lanes hidden) and the panel (which grows to fill the
 * row): the three must agree on the same frame. If MainSurface hid the lanes
 * while App kept <main> at flex-1, the window would show an empty half; if
 * the panel grew while <main> kept its width, the two would split the row.
 *
 * WHY Settings beats it: Settings is the one takeover that hides the Sidekick
 * too (SidekickPanelSurface), so with Settings open, Settings must be what
 * <main> shows.
 */
export function sidekickSpotlightActive(
  flags: { sidekickSpotlight: boolean; settingsPageOpen: boolean },
  workspaceState: Pick<WorkspaceState, 'sidekickPanel'>,
): boolean {
  return flags.sidekickSpotlight && !flags.settingsPageOpen && workspaceState.sidekickPanel?.open === true
}

export function useSidekickSpotlightActive(workspaceState: Pick<WorkspaceState, 'sidekickPanel'>): boolean {
  const sidekickSpotlight = useAppStore(state => state.sidekickSpotlight)
  const settingsPageOpen = useAppStore(state => state.settingsPageOpen)
  return sidekickSpotlightActive({ sidekickSpotlight, settingsPageOpen }, workspaceState)
}
