import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { useAppStore } from '@renderer/app-state/store'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'

// Attach-Recording-Note command body (plan §7b). Kept out of sessionCommands
// so the command file stays focused on palette registration and so this logic
// is reusable from a keybinding later (the plan wants this to be a reflex
// during a soak) — mirrors why runSaveDebugBundleCommand lives in
// saveDebugBundle.ts, not inline in the command.
//
// THE reserve-first gesture is the whole point. We call reserveRecordingNote
// BEFORE opening the input, so the marker's timestamp pins the tick the
// operator reacted to — not the tick several hundred ms / seconds later when
// they finish typing. This is identical to why "save debug logs" captures on
// click, not on note-entry.
export async function runAttachRecordingNoteCommand(workspace: Workspace): Promise<void> {
  const sessionId = commandTargetSessionId(workspace)
  if (!sessionId) return

  const meta = workspace.state.sessions[sessionId]
  const kind = meta?.kind ?? DEFAULT_PROVIDER

  // Reserve INSTANTLY — this is the tick-pinning write. Returns null when
  // there is no active recording for this session (recording not gated on, or
  // the session never produced a recorded event). In that case there is
  // nothing to annotate: toast and bail rather than opening a dead input.
  let noteId: string | null = null
  try {
    noteId = await window.api.reserveRecordingNote(sessionId)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    workspace.showPaneToast(sessionId, `recording note failed: ${message}`, 4000)
    return
  }

  if (!noteId) {
    workspace.showPaneToast(sessionId, 'no active recording for this pane', 3000)
    return
  }

  // Marker is now claimed. Open the input; the fill step (App.tsx onConfirm)
  // updates this noteId with the typed text. If the operator cancels, the
  // reserved marker stays — a bare timestamp is still a useful flag.
  useAppStore.getState().openRecordingNotePrompt({
    sessionId,
    noteId,
    title: `${kind} · ${meta?.cwd?.split('/').filter(Boolean).pop() ?? sessionId}`,
  })
}
