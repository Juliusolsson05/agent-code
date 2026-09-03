import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'

import { AgentTerminalOwnerVisibilityProvider } from '@renderer/workspace/terminal/AgentTerminalOwnership'

// The workspace subtree that survives focus-takeover surfaces (#752).
//
// WHY the workspace is hidden rather than unmounted while Settings, Reader
// Mode or Spotlight own the screen: every pane in the tile tree owns live
// state that is expensive or impossible to rebuild — an xterm instance with
// its PTY attachment and scrollback, a feed's scroll position, Monaco
// buffers. MainSurface used to render the takeover surface INSTEAD of the
// shell, so entering Reader Mode with terminal panes disposed every xterm
// and leaving re-attached every PTY and replayed up to 512 KiB into each
// brand-new terminal: a multi-second freeze and lost scrollback per toggle.
// Global Editor fullscreen had the same problem and solved it by retaining
// the subtree under display:none (GlobalEditorWorkspaceSlot); this is the
// same pattern one level up, for the surfaces that bypass the shell.
//
// WHY `display: contents` when visible: the wrapper must be layout-neutral so
// the shell's own flex sizing is unchanged; a hidden wrapper is `display:
// none`, which removes the subtree from layout (scrollHeight 0, no paint) but
// keeps every component mounted.
//
// WHY the terminal visibility provider sits here: "mounted" no longer means
// "can measure a viewport". MountedAgentTerminalOwner reads this to withhold
// the dimension claim while hidden, exactly as it does for editor fullscreen,
// so a hidden pane neither fights the debug inline terminal nor sends a
// zero-sized resize to the PTY.
//
// WHY a separate hidden context: some consumers need "is my subtree retained
// but off-screen" for reasons unrelated to terminals — TileLeaf's Tail-All
// mask must turn false while hidden so that un-hiding is a real false→true
// transition that re-pins the feed (see the mask comment in TileLeaf).
export const WorkspaceSurfaceHiddenContext = createContext(false)

export function useWorkspaceSurfaceHidden(): boolean {
  return useContext(WorkspaceSurfaceHiddenContext)
}

export function RetainedWorkspaceSurface({
  hidden,
  children,
}: {
  hidden: boolean
  children: ReactNode
}) {
  return (
    <WorkspaceSurfaceHiddenContext.Provider value={hidden}>
      <AgentTerminalOwnerVisibilityProvider visible={!hidden}>
        <div
          data-testid="retained-workspace-surface"
          style={hidden ? { display: 'none' } : { display: 'contents' }}
        >
          {children}
        </div>
      </AgentTerminalOwnerVisibilityProvider>
    </WorkspaceSurfaceHiddenContext.Provider>
  )
}
