import type { TabId, SessionId } from '../../tiles/types'

export type UiShellState = {
  commandPaletteOpen: boolean
  pathPickerOpen: boolean
  pathPickerDefault: string
  tileTabsModalOpen: boolean
  tileTabsInitialSelectedIds: TabId[]
  settingsPageOpen: boolean
  buryPromptSessionId: SessionId | null
  viewPromptsSessionId: SessionId | null
  newAgentPlacementOpen: boolean
  gitBarOpen: boolean
  debugPanelOpen: boolean
  /** When true, the right-hand Proxy Debug Panel is mounted. Shows
   *  the live SSE flow for the focused Claude session: flow
   *  attribution, per-turn/per-block state, text deltas, stop reason,
   *  usage. Opt-in view — only meaningful when the session was spawn
   *  with `useProxy` on, since the panel is driven by semantic events
   *  from the proxy adapter. */
  proxyDebugPanelOpen: boolean
}
