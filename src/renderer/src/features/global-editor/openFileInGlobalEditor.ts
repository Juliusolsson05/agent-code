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
  const result = await window.api.editorReadTextFile({ root, path }).catch(err => ({
    ok: false as const,
    error: err instanceof Error ? err.message : 'read failed',
  }))
  if (!result.ok) return { ok: false, error: result.error }

  const selection = line
    ? {
        line,
        column: column ?? 1,
      }
    : null

  // WHY rendered-content file activation reuses the Global Editor store
  // instead of opening file: URLs or delegating to the OS: assistant/provider
  // output is untrusted text, and Electron navigation is exactly the thing
  // issue #180 is hardening against. The editor-fs IPC already enforces
  // project-root containment in main, and Global Editor already owns dirty
  // buffer preservation, tab ordering, and language detection. Reusing that
  // path means a clicked markdown path behaves like a file-tree click rather
  // than becoming a second filesystem policy surface.
  useGlobalEditorStore.getState().openFile({
    cwd: root,
    path: result.path,
    text: result.text,
    mtimeMs: result.mtimeMs,
    selection,
  })
  useAppStore.getState().openGlobalEditor()
  return { ok: true }
}
