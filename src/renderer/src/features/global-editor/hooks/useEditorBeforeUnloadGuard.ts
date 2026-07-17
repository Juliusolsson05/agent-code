import { useEffect } from 'react'

import { hasDirtyAiWorkspaceBuffers } from '@renderer/features/ai-workspace/lib/aiWorkspaceSurfaceCache'
import { useGlobalEditorStore } from '@renderer/features/global-editor/store'

function hasDirtyProjectBuffers(): boolean {
  return Object.values(useGlobalEditorStore.getState().byCwd).some(cwd =>
    Object.values(cwd.openFiles).some(buffer => buffer.dirty),
  )
}

// Window close/reload bypasses every tab-level dialog. beforeunload is the one
// synchronous browser contract Electron honors during that teardown, so read
// both stores at event time and request the platform confirmation. Merely
// hiding the Global Editor does not prompt because both state owners remain
// alive; only a document/window destruction that would truly lose text does.
export function useEditorBeforeUnloadGuard(): void {
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!hasDirtyProjectBuffers() && !hasDirtyAiWorkspaceBuffers()) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', guard)
    return () => window.removeEventListener('beforeunload', guard)
  }, [])
}
