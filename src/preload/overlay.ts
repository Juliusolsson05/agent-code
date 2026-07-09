import { contextBridge } from 'electron'

import { agentOverlayApi } from '@preload/api/agentOverlay.js'

// Slim preload for the agent-status overlay window — least privilege.
//
// The main window's preload (index.ts) exposes the ENTIRE flattened api
// surface: sessions, filesystem, git, remote control, debug tooling. The
// overlay is a status pip; handing it that bridge would make every
// renderer bug in a tiny always-on-top window as dangerous as one in the
// main app (PR #514 review finding 2). So it gets exactly the four
// methods it calls and nothing else.
//
// The overlay renderer still type-checks against the FULL `Api` global
// (there is one ambient window.api declaration for all renderer code).
// That means TypeScript would happily let overlay code call a method
// that doesn't exist here at runtime — if you add a window.api call to
// OverlayApp.tsx, you MUST add the method to this pick list too, or it
// throws only when the overlay actually runs.

const overlayApi = {
  onAgentOverlayState: agentOverlayApi.onAgentOverlayState,
  agentOverlaySetExpanded: agentOverlayApi.agentOverlaySetExpanded,
  agentOverlayResize: agentOverlayApi.agentOverlayResize,
  agentOverlayFocusSession: agentOverlayApi.agentOverlayFocusSession,
}

contextBridge.exposeInMainWorld('api', overlayApi)
