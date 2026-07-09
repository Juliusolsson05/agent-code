import { ipcRenderer } from 'electron'

import type {
  AgentOverlaySnapshot,
  AgentOverlayStateEvent,
} from '@shared/types/agentOverlay.js'
import { subscribe } from '@preload/api/ipc.js'
import type { Unsub } from '@preload/api/types.js'

// Floating agent-status overlay bridge. Unusually for this API surface,
// TWO different renderers consume it: the main window (report / toggle /
// onEnabledChanged / onFocusSession relay) and the overlay window itself
// (onState / setExpanded / resize / focusSession). Both load the same
// preload bundle, so the split is by which methods each one calls, not by
// build artifact — see the flow map in main/ipc/agentOverlay.ts.

export const agentOverlayApi = {
  // -- main-window renderer side ------------------------------------------
  agentOverlayToggle: (): Promise<boolean> =>
    ipcRenderer.invoke('agent-overlay:toggle'),

  agentOverlayGetEnabled: (): Promise<boolean> =>
    ipcRenderer.invoke('agent-overlay:get-enabled'),

  /** Fire-and-forget on purpose: this rides every (throttled) store change
   *  in the main renderer; an invoke round-trip would buy nothing. */
  agentOverlayReport: (snapshot: AgentOverlaySnapshot): void =>
    ipcRenderer.send('agent-overlay:report', snapshot),

  onAgentOverlayEnabledChanged: (
    handler: (payload: { enabled: boolean }) => void,
  ): Unsub => subscribe('agent-overlay:enabled-changed', handler),

  /** Main-window side of an overlay row click: main has already raised the
   *  app window; the workspace decides which tab/pane to focus. */
  onAgentOverlayFocusSession: (
    handler: (payload: { sessionId: string }) => void,
  ): Unsub => subscribe('agent-overlay:focus-session', handler),

  // -- overlay-window renderer side ----------------------------------------
  onAgentOverlayState: (
    handler: (payload: AgentOverlayStateEvent) => void,
  ): Unsub => subscribe('agent-overlay:state', handler),

  agentOverlaySetExpanded: (expanded: boolean): void =>
    ipcRenderer.send('agent-overlay:set-expanded', expanded),

  agentOverlayResize: (size: { width: number; height: number }): void =>
    ipcRenderer.send('agent-overlay:resize', size),

  agentOverlayFocusSession: (sessionId: string): void =>
    ipcRenderer.send('agent-overlay:focus-session', { sessionId }),
}
