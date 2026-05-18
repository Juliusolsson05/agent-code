import { useAppStore } from '@renderer/app-state/store'
import { useGlobalEditorStore } from '@renderer/features/global-editor/store'

export type OpenFileInGlobalEditorParams = {
  root: string
  path: string
  line?: number | null
  column?: number | null
}

export async function openFileInGlobalEditor({
  root,
  path,
  line,
  column,
}: OpenFileInGlobalEditorParams): Promise<{ ok: true } | { ok: false; error: string }> {
  const editor = useGlobalEditorStore.getState()
  const existing = editor.byCwd[root]?.openFiles[path]
  const selection = line
    ? {
        line,
        column: column ?? 1,
      }
    : null

  if (existing && !existing.dirty && !selection) {
    // WHY this fast path belongs in the global open helper, not only the file
    // tree: rendered markdown links, command-palette actions, and explorer
    // clicks all funnel through here. Re-clicking an already-open clean tab
    // should be a local tab activation, not a main-process stat+read+IPC
    // roundtrip. Dirty buffers still go through the read path because
    // store.openFile refreshes their savedText/mtime while preserving edits.
    editor.setActiveFile(root, path)
    editor.setActiveCwd(root)
    useAppStore.getState().openGlobalEditor()
    return { ok: true }
  }

  const result = await window.api.editorReadTextFile({ root, path }).catch(err => ({
    ok: false as const,
    error: err instanceof Error ? err.message : 'read failed',
  }))
  if (!result.ok) return { ok: false, error: result.error }

  // WHY rendered-content file activation reuses the Global Editor store
  // instead of opening file: URLs or delegating to the OS: assistant/provider
  // output is untrusted text, and Electron navigation is exactly the thing
  // issue #180 is hardening against. The editor-fs IPC already enforces
  // project-root containment in main, and Global Editor already owns dirty
  // buffer preservation, tab ordering, and language detection. Reusing that
  // path means a clicked markdown path behaves like a file-tree click rather
  // than becoming a second filesystem policy surface.
  editor.openFile({
    cwd: root,
    path: result.path,
    text: result.text,
    mtimeMs: result.mtimeMs,
    selection,
  })
  // A rendered link can come from a non-active pane, a previewed session, or a
  // workspace different from the editor's current `activeCwd`. Opening the
  // buffer without switching the active cwd would make the click technically
  // succeed while leaving the user staring at the previous project. File
  // activation is a navigation intent, so make the opened file's root the
  // visible editor root before showing the editor.
  editor.setActiveCwd(root)
  useAppStore.getState().openGlobalEditor()
  return { ok: true }
}
