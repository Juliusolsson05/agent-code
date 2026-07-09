import { DebugBundleNotePrompt } from '@renderer/features/debug/ui/DebugBundleNotePrompt'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

export function DebugBundleNoteSurface() {
  const workspace = useWorkspaceContext()
  const prompt = useAppStore(state => state.debugBundleNotePrompt)
  const close = useAppStore(state => state.closeDebugBundleNotePrompt)
  return (
    <DebugBundleNotePrompt
      open={prompt !== null}
      title={prompt?.title ?? ''}
      description={prompt?.description ?? ''}
      bundlePath={prompt?.bundlePath ?? ''}
      onCancel={close}
      onConfirm={note => {
        if (!prompt) return
        const trimmed = note.trim()
        close()
        if (!trimmed) return
        void window.api.addDebugBundleNote({
          bundlePath: prompt.bundlePath,
          note: trimmed,
        }).then(
          () => workspace.showPaneToast(prompt.sessionId, 'debug note saved', 3000),
          err => {
            const message = err instanceof Error ? err.message : String(err)
            workspace.showPaneToast(prompt.sessionId, `debug note failed: ${message}`, 5000)
          },
        )
      }}
    />
  )
}
