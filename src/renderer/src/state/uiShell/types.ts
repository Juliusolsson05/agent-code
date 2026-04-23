import type { TabId, SessionId } from '@renderer/workspace/types'

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
  feedDebugPanelOpen: boolean
  /** When true, the right-hand Proxy Debug Panel is mounted. Shows
   *  the live SSE flow for the focused Claude session: flow
   *  attribution, per-turn/per-block state, text deltas, stop reason,
   *  usage. Opt-in view — only meaningful when the session was spawn
   *  with `useProxy` on, since the panel is driven by semantic events
   *  from the proxy adapter. */
  proxyDebugPanelOpen: boolean
  /** When true, the HTML Debug Panel is mounted. Captures `outerHTML`
   *  of the focused pane (located via the `data-pane-id` attribute on
   *  the TileLeaf root) so the user can copy the exact DOM React
   *  produced — useful for rendering debugging / pasting layouts into
   *  an LLM. Snapshot-based, not live; refresh button re-captures.
   *  Lives on the uiShell slice alongside the other three debug panels
   *  and follows the same toggle pattern. */
  htmlDebugPanelOpen: boolean
  /** When true, the Search Conversation Prompts modal is open. Lives
   *  on the uiShell slice (not the workspace slice) because it's
   *  a cross-session concern: the modal reads prompts from ALL
   *  sessions on disk, not just those currently mounted. */
  promptSearchOpen: boolean
  /** When true, the Agent Activity modal is open. Lists every
   *  visible agent/terminal session grouped by tab with last-
   *  activity timestamps so the user can triage and close unused
   *  panes during a long session. Derived from existing transcript
   *  data — no separate tracking store. */
  agentActivityOpen: boolean
  /** Non-null when the Rewind-to-Prompt modal is open. Value is the
   *  sessionId whose transcript the modal is showing prompts for.
   *  Selecting a prompt in the modal calls
   *  `workspace.rewindFocusedToPrompt(anchor)` and the modal closes.
   *  See `RewindToPromptModal` + the parent plan doc for the full
   *  contract. */
  rewindPromptSessionId: SessionId | null
}
