import { DebugBundleNotePrompt } from '@renderer/features/debug/ui/DebugBundleNotePrompt'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

// Attach-Recording-Note input (plan §7b). Reuses the debug-bundle note
// modal with recording-specific labels. The `reserved` marker is
// already written by the time this opens; onConfirm fills it. Cancel
// leaves the reserved marker in place — a bare timestamp is still a
// useful flag, so we do NOT delete it on skip.
export function RecordingNoteSurface() {
  const workspace = useWorkspaceContext()
  const prompt = useAppStore(state => state.recordingNotePrompt)
  const close = useAppStore(state => state.closeRecordingNotePrompt)
  return (
    <DebugBundleNotePrompt
      open={prompt !== null}
      heading="Attach Recording Note"
      fieldLabel="Note"
      placeholder="What did you see? (marks the exact recorded tick)"
      title={prompt?.title ?? ''}
      description=""
      bundlePath=""
      onCancel={close}
      onConfirm={note => {
        if (!prompt) return
        const trimmed = note.trim()
        close()
        if (!trimmed) return
        void window.api.fillRecordingNote(prompt.sessionId, prompt.noteId, trimmed).then(
          () => workspace.showPaneToast(prompt.sessionId, 'recording note attached', 3000),
          err => {
            const message = err instanceof Error ? err.message : String(err)
            workspace.showPaneToast(prompt.sessionId, `recording note failed: ${message}`, 5000)
          },
        )
      }}
    />
  )
}
