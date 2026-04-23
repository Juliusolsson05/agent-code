import { useCallback } from 'react'

import type { WorkspaceSetStatusMode } from '../context'

// Status mode: color-coded pane headers. Toggled from the command
// palette. The slice lives in zustand — this action just flips it.

export function useStatusModeActions(setStatusMode: WorkspaceSetStatusMode): {
  toggleStatusMode: () => void
} {
  const toggleStatusMode = useCallback(() => {
    setStatusMode(prev => !prev)
  }, [setStatusMode])

  return { toggleStatusMode }
}
