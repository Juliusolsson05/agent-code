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
//   - The tab-close path releases its buffer generation as an owner. The
//     model is disposed only after the last logical owner and mounted viewer
//     are both gone.
//   - Models are keyed by absolutePath because that is what
//     monaco.Uri.file() keys on; two cwds can't collide (absolute
//     paths).
//
// WHY zero refs alone does NOT dispose: an open-but-inactive tab has zero
// mounted viewers and must keep its undo stack alive — that's the whole
// point. Logical owners are registered on first mount and survive later tab
// switches. The memory cost is bounded by files the user deliberately opened.

type Entry = {
  model: Monaco.editor.ITextModel
  refs: number
  /** Buffer generations, not mounted editor instances. Two surfaces can own
   * the same absolute file while only one is visible. */
  owners: Set<number>
}
const entries = new Map<string, Entry>()
const pathByOwner = new Map<number, string>()

function disposeIfUnowned(absolutePath: string, entry: Entry): void {
  if (entry.refs > 0 || entry.owners.size > 0) return
  if (entries.get(absolutePath) === entry) entries.delete(absolutePath)
  if (!entry.model.isDisposed()) entry.model.dispose()
}

function bindOwner(ownerId: number, absolutePath: string, entry: Entry): void {
  const previousPath = pathByOwner.get(ownerId)
  if (previousPath && previousPath !== absolutePath) {
    const previous = entries.get(previousPath)
    if (previous) {
      previous.owners.delete(ownerId)
      disposeIfUnowned(previousPath, previous)
    }
  }
  pathByOwner.set(ownerId, absolutePath)
  entry.owners.add(ownerId)
}

function replaceModelTextPreservingUndo(model: Monaco.editor.ITextModel, text: string): void {
  if (model.getValue() === text) return
  // setValue wipes the complete undo stack. A disk reload/external update is
  // itself an edit boundary that users reasonably expect Cmd+Z to recover
  // from, so replace the full range through Monaco's edit machinery instead.
  model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null)
}

export function acquireEditorModel(
  monaco: typeof Monaco,
  params: { absolutePath: string; text: string; monacoLangId: string; ownerId: number },
): Monaco.editor.ITextModel {
  const existing = entries.get(params.absolutePath)
  if (existing && !existing.model.isDisposed()) {
    existing.refs += 1
    bindOwner(params.ownerId, params.absolutePath, existing)
    // A rename can change the extension while retaining the same semantic
    // buffer (for example .js → .ts). Monaco language is model state, not an
    // editor option, so reusing the model without updating it leaves the old
    // tokenizer and providers attached indefinitely.
    if (existing.model.getLanguageId() !== params.monacoLangId) {
      monaco.editor.setModelLanguage(existing.model, params.monacoLangId)
    }
    // Buffer text is the source of truth (it survives the model when the
    // app reloads a file from disk); only touch the model when they
    // actually differ — setValue clears the undo stack, which is the
    // thing this registry exists to protect.
    replaceModelTextPreservingUndo(existing.model, params.text)
    return existing.model
  }
  const uri = monaco.Uri.file(params.absolutePath)
  // A stale model can exist under this URI if a previous dispose path
  // leaked it; reuse rather than crash (createModel throws on duplicate
  // URIs).
  const model =
    monaco.editor.getModel(uri) ?? monaco.editor.createModel(params.text, params.monacoLangId, uri)
  if (model.getLanguageId() !== params.monacoLangId) {
    monaco.editor.setModelLanguage(model, params.monacoLangId)
  }
  replaceModelTextPreservingUndo(model, params.text)
  const entry: Entry = { model, refs: 1, owners: new Set() }
  entries.set(params.absolutePath, entry)
  bindOwner(params.ownerId, params.absolutePath, entry)
  return model
}

export function releaseEditorModel(absolutePath: string): void {
  const entry = entries.get(absolutePath)
  if (!entry) return
  entry.refs = Math.max(0, entry.refs - 1)
  // Zero viewers alone is not disposal: an inactive open tab still owns the
  // undo model. Once its final buffer owner also closes, a delayed component
  // cleanup is allowed to finish disposal here.
  disposeIfUnowned(absolutePath, entry)
}

export function releaseEditorModelOwner(ownerId: number): void {
  const absolutePath = pathByOwner.get(ownerId)
  if (!absolutePath) return
  pathByOwner.delete(ownerId)
  const entry = entries.get(absolutePath)
  if (!entry) return
  entry.owners.delete(ownerId)
  disposeIfUnowned(absolutePath, entry)
}

/** Hygiene hook for evicting a whole project's models (e.g. if a future
 *  change trims byCwd). Not called in the steady state today. */
export function disposeAllEditorModelsUnder(rootAbs: string): void {
  const prefix = rootAbs.endsWith('/') ? rootAbs : `${rootAbs}/`
  for (const [path, entry] of [...entries]) {
    if (!path.startsWith(prefix)) continue
    for (const ownerId of entry.owners) pathByOwner.delete(ownerId)
    entry.owners.clear()
    disposeIfUnowned(path, entry)
  }
}

/** Join a cwd root and store-relative path into the registry/model key.
 *  Mirrors the Global Editor store's absolutePath() join so both sides
 *  derive identical keys for the same buffer. */
export function editorModelKey(root: string, relativePath: string): string {
  return `${root.replace(/\/+$/, '')}/${relativePath.replace(/^\/+/, '')}`
}
