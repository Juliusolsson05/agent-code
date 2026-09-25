import type { ReactNode } from 'react'

import { WorkspaceSurfaceHiddenContext, useWorkspaceSurfaceHidden } from '@renderer/app/shell/RetainedWorkspaceSurface'
import { AgentTerminalOwnerVisibilityProvider } from '@renderer/workspace/terminal/AgentTerminalOwnership'

type Props = {
  open: boolean
  editorFullscreen: boolean
  splitWorkspaceWidth: string
  children: ReactNode
}

/**
 * The retained workspace half of Global Editor's overlay.
 *
 * WHY this tiny layout boundary is named and tested separately: fullscreen
 * does not unmount the workspace—it hides it so xterm, scroll, and renderer
 * state survive. Terminal dimension arbitration cannot infer that distinction
 * from React mount state. Keeping the CSS hiding rule and the visibility signal
 * in one component makes it impossible to change one without reviewing the
 * other, and lets the regression exercise the real retained DOM instead of a
 * GlobalEditorShell passthrough mock.
 */
export function GlobalEditorWorkspaceSlot({
  open,
  editorFullscreen,
  splitWorkspaceWidth,
  children,
}: Props) {
  // WHY this slot also says "hidden" through the retained-surface context
  // (#1269): it is the same retained-under-display:none situation as a
  // takeover, and input owners inside (the New Agent overlay) must stand down
  // here too. OR'ed with the outer value so a takeover over a split editor
  // still reads hidden. GlobalEditorShell, the context's other reader, reads
  // it from OUTSIDE this slot, so its own Escape gate is unchanged.
  const outerHidden = useWorkspaceSurfaceHidden()
  const hidden = outerHidden || (open && editorFullscreen)
  return (
    <WorkspaceSurfaceHiddenContext.Provider value={hidden}>
      <AgentTerminalOwnerVisibilityProvider visible={!open || !editorFullscreen}>
        <div
          className="flex flex-col min-h-0 overflow-hidden"
          style={
            !open
              ? { width: '100%' }
              : editorFullscreen
                ? { display: 'none' }
                : { width: splitWorkspaceWidth }
          }
        >
          {children}
        </div>
      </AgentTerminalOwnerVisibilityProvider>
    </WorkspaceSurfaceHiddenContext.Provider>
  )
}
