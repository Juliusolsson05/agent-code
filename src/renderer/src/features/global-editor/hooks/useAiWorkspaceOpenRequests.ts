import { useEffect } from 'react'
import { useAppStore } from '@renderer/app-state/hooks'
import { useGlobalEditorStore } from '@renderer/features/global-editor/store'

// Root effect extracted from App.tsx (#494). Main pushes "open this AI
// workspace" requests (deep links, MCP); the renderer answers by opening
// the workspace in the global editor and revealing the editor. Lives in
// global-editor because that is the surface being opened — the
// subscription is just its doorbell.
export function useAiWorkspaceOpenRequests(): void {
  useEffect(() => {
    const off = window.api.onAiWorkspaceOpenRequest(request => {
      useGlobalEditorStore.getState().openAiWorkspace(request.workspaceId)
      useAppStore.getState().openGlobalEditor()
    })
    return off
  }, [])
}
