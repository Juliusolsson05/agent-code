import { useAppStore } from '@renderer/app-state/store'
import { useGlobalEditorStore } from '@renderer/features/global-editor/store'

export type OpenFileInGlobalEditorParams = {
  root: string
  path: string
  line?: number | null
  column?: number | null
  /** Restore/revalidation may populate a buffer without changing the visible tab. */
  activate?: boolean
  /** Only explicit navigation should steal keyboard focus from the workspace. */
  focus?: boolean
}

export type OpenFileInGlobalEditorResult =
  | { ok: true; opened: boolean }
  | { ok: false; error: string }

let navigationSequence = 0
let requestSequence = 0
let requestEpoch = 0
const latestRequestByFile = new Map<string, number>()

function requestKey(root: string, path: string): string {
  return `${root}\0${path}`
}

/** Invalidate an in-flight read after the corresponding tab was closed. The
 * read IPC cannot be aborted, so the completion must lose the right to create
 * a new buffer lifetime when it eventually resolves. */
export function cancelPendingGlobalEditorFileOpen(root: string, path: string): void {
  const key = requestKey(root, path)
  // Ordinary tab closes call this even when no read is pending. Recording a
  // tombstone for that common path grows the module-lifetime map forever; an
  // absent key already means there is no completion left to invalidate.
  if (latestRequestByFile.has(key)) latestRequestByFile.set(key, ++requestSequence)
}

/** Closing the whole surface cancels navigation as well as activation. A late
 * disk read may still finish, but it must not reopen the editor behind the
 * user's explicit close gesture. */
export function cancelAllPendingGlobalEditorFileOpens(): void {
  requestEpoch += 1
  navigationSequence += 1
  latestRequestByFile.clear()
}

export async function openFileInGlobalEditor({
  root,
  path,
  line,
  column,
  activate = true,
  focus = true,
}: OpenFileInGlobalEditorParams): Promise<OpenFileInGlobalEditorResult> {
  const editorAtStart = useGlobalEditorStore.getState()
  const appWasOpen = useAppStore.getState().globalEditorOpen
  const existingGeneration = editorAtStart.byCwd[root]?.openFiles[path]?.generation ?? null
  const key = requestKey(root, path)
  const requestId = ++requestSequence
  const epoch = requestEpoch
  latestRequestByFile.set(key, requestId)
  const navigationId = activate ? ++navigationSequence : null
  const selection = line
    ? {
        line,
        column: column ?? 1,
      }
    : null

  // WHY we still read when the tab is already open and clean: agent writes
  // commonly happen outside the editor store. The visible cwd has watchers,
  // but background/restoring buffers do not, and watcher delivery itself is
  // best-effort. A click on the tree or rendered path is the user's explicit
  // "show me this file now" intent, so it must revalidate against disk instead
  // of assuming the in-memory clean buffer is current. Dirty buffers remain
  // protected by store.openFile, which observes divergence without advancing
  // their optimistic-save baseline or replacing their edits.
  const result = await window.api.editorReadTextFile({ root, path }).catch(err => ({
    ok: false as const,
    error: err instanceof Error ? err.message : 'read failed',
  }))
  const editor = useGlobalEditorStore.getState()
  const currentBuffer = editor.byCwd[root]?.openFiles[path]
  if (
    epoch !== requestEpoch ||
    latestRequestByFile.get(key) !== requestId ||
    (appWasOpen && !useAppStore.getState().globalEditorOpen) ||
    (existingGeneration !== null && currentBuffer?.generation !== existingGeneration)
  ) {
    // Cancellation is a successful no-op to callers. Surfacing a scary "read
    // failed" toast after the user deliberately closed/superseded the request
    // would turn correct race handling into a visible error.
    if (latestRequestByFile.get(key) === requestId) latestRequestByFile.delete(key)
    return { ok: true, opened: false }
  }
  if (!result.ok) {
    if (latestRequestByFile.get(key) === requestId) latestRequestByFile.delete(key)
    return { ok: false, error: result.error }
  }

  // WHY rendered-content file activation reuses the Global Editor store
  // instead of opening file: URLs or delegating to the OS: assistant/provider
  // output is untrusted text, and Electron navigation is exactly the thing
  // issue #180 is hardening against. The editor-fs IPC already enforces
  // project-root containment in main, and Global Editor already owns dirty
  // buffer preservation, tab ordering, and language detection. Reusing that
  // path means a clicked markdown path behaves like a file-tree click rather
  // than becoming a second filesystem policy surface.
  // A slow earlier click may resolve after a later one. It is still useful to
  // populate the earlier tab in the background, but only the latest explicit
  // navigation may activate/focus it or switch the visible project root.
  const shouldActivate = activate && navigationId !== null && navigationId === navigationSequence
  editor.openFile({
    cwd: root,
    path: result.path,
    absolutePath: result.absolutePath,
    text: result.text,
    mtimeMs: result.mtimeMs,
    diskVersion: result.version,
    selection,
    activate: shouldActivate,
    focus: shouldActivate && focus,
  })
  // A rendered link can come from a non-active pane, a previewed session, or a
  // workspace different from the editor's current `activeCwd`. Opening the
  // buffer without switching the active cwd would make the click technically
  // succeed while leaving the user staring at the previous project. File
  // activation is a navigation intent, so make the opened file's root the
  // visible editor root before showing the editor.
  if (shouldActivate) {
    editor.setActiveCwd(root)
    // A project-file navigation must reveal the project editor even when a
    // curated AI Workspace currently owns the surface. The AI Workspace is
    // only hidden here (its component remains mounted), so unsaved review
    // edits survive the round-trip.
    editor.showProjectEditor()
    useAppStore.getState().openGlobalEditor()
  }
  if (latestRequestByFile.get(key) === requestId) latestRequestByFile.delete(key)
  return { ok: true, opened: true }
}
