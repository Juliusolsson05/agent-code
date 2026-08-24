import type { ReactNode } from 'react'

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
  return (
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
  )
}
