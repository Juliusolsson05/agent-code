import { useEffect } from 'react'

import { hasDirtyAiWorkspaceBuffers } from '@renderer/features/ai-workspace/lib/aiWorkspaceSurfaceCache'
import { hasRecoverableBufferChanges } from '@renderer/features/editor/lib/bufferOps'
import { useGlobalEditorStore } from '@renderer/features/global-editor/store'

function hasDirtyProjectBuffers(): boolean {
  return Object.values(useGlobalEditorStore.getState().byCwd).some(cwd =>
    Object.values(cwd.openFiles).some(hasRecoverableBufferChanges),
  )
}

// Window close/reload bypasses every tab-level dialog. beforeunload is the one
// synchronous renderer veto Electron honors during that teardown, so read both
// stores at event time. The main process owns the native confirmation shown for
// that veto; browser-style confirmation UI is neither reliable nor descriptive
// in a desktop app. Merely
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
