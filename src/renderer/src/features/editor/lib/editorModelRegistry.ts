import type * as Monaco from 'monaco-editor'

// Ref-counted Monaco model ownership for the file editor.
//
// WHY: MonacoFileEditor used to create AND dispose the model inside its
// mount effect, keyed on file.path — so every tab switch destroyed the
// model, and with it the undo stack, folding state, and tokenization
// warm-up. Buffers survive in zustand as plain strings, but Cmd+Z
// history lived only on the model. Model lifetime must therefore follow
// the BUFFER lifetime (open tab), not the COMPONENT lifetime (visible
// tab).
//
// Ownership contract:
//   - MonacoFileEditor acquires on mount / releases on unmount (it is a
//     *viewer* of the model, not its owner).
//   - The tab-close path (host close callbacks → store.closeFile
//     returning true) calls disposeEditorModel — the close is the actual
//     end of the buffer's life.
//   - Models are keyed by absolutePath because that is what
//     monaco.Uri.file() keys on; two cwds can't collide (absolute
//     paths).
//
// WHY zero refs does NOT dispose: an open-but-inactive tab has zero
// mounted viewers and must keep its undo stack alive — that's the whole
// point. The memory cost is bounded by "files the user deliberately has
// open as tabs", which is the same order as any real editor.

type Entry = { model: Monaco.editor.ITextModel; refs: number }
const entries = new Map<string, Entry>()

export function acquireEditorModel(
  monaco: typeof Monaco,
  params: { absolutePath: string; text: string; monacoLangId: string },
): Monaco.editor.ITextModel {
  const existing = entries.get(params.absolutePath)
  if (existing && !existing.model.isDisposed()) {
    existing.refs += 1
    // Buffer text is the source of truth (it survives the model when the
    // app reloads a file from disk); only touch the model when they
    // actually differ — setValue clears the undo stack, which is the
    // thing this registry exists to protect.
    if (existing.model.getValue() !== params.text) {
      existing.model.setValue(params.text)
    }
    return existing.model
  }
  const uri = monaco.Uri.file(params.absolutePath)
  // A stale model can exist under this URI if a previous dispose path
  // leaked it; reuse rather than crash (createModel throws on duplicate
  // URIs).
  const model =
    monaco.editor.getModel(uri) ??
    monaco.editor.createModel(params.text, params.monacoLangId, uri)
  if (model.getValue() !== params.text) model.setValue(params.text)
  entries.set(params.absolutePath, { model, refs: 1 })
  return model
}

export function releaseEditorModel(absolutePath: string): void {
  const entry = entries.get(absolutePath)
  if (!entry) return
  entry.refs = Math.max(0, entry.refs - 1)
  // Intentionally NOT disposing at zero refs — see module header.
}

export function disposeEditorModel(absolutePath: string): void {
  const entry = entries.get(absolutePath)
  entries.delete(absolutePath)
  if (entry && !entry.model.isDisposed()) entry.model.dispose()
}

/** Hygiene hook for evicting a whole project's models (e.g. if a future
 *  change trims byCwd). Not called in the steady state today. */
export function disposeAllEditorModelsUnder(rootAbs: string): void {
  const prefix = rootAbs.endsWith('/') ? rootAbs : `${rootAbs}/`
  for (const [path] of [...entries]) {
    if (path.startsWith(prefix)) disposeEditorModel(path)
  }
}

/** Join a cwd root and store-relative path into the registry/model key.
 *  Mirrors the Global Editor store's absolutePath() join so both sides
 *  derive identical keys for the same buffer. */
export function editorModelKey(root: string, relativePath: string): string {
  return `${root.replace(/\/+$/, '')}/${relativePath.replace(/^\/+/, '')}`
}
