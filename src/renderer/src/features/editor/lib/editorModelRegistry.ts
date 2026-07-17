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
//   - MonacoFileEditor acquires on mount / releases its generation on unmount
//     (it is a *viewer* of the model, not its owner).
//   - The tab-close path releases its buffer generation as an owner. The
//     model is disposed only after the last logical owner and mounted viewer
//     are both gone.
//   - Models are keyed by buffer generation, not path. Global Editor and AI
//     Workspace can intentionally hold independent drafts of the same file;
//     sharing Monaco's path URI made typing in one silently mutate the other.
//
// WHY zero refs alone does NOT dispose: an open-but-inactive tab has zero
// mounted viewers and must keep its undo stack alive — that's the whole
// point. Logical owners are registered on first mount and survive later tab
// switches. The memory cost is bounded by files the user deliberately opened.

type Entry = {
  model: Monaco.editor.ITextModel
  refs: number
  absolutePath: string
  ownerActive: boolean
}
const entries = new Map<number, Entry>()

function disposeIfUnowned(ownerId: number, entry: Entry): void {
  if (entry.refs > 0 || entry.ownerActive) return
  if (entries.get(ownerId) === entry) entries.delete(ownerId)
  if (!entry.model.isDisposed()) entry.model.dispose()
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
  const existing = entries.get(params.ownerId)
  if (existing && !existing.model.isDisposed()) {
    existing.refs += 1
    existing.ownerActive = true
    existing.absolutePath = params.absolutePath
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
  // Monaco globally de-duplicates models by URI. Preserve the real file path
  // (workers use its extension) but add the buffer lifetime as an opaque query
  // so two surfaces editing the same disk file never share text/undo state.
  const uri = monaco.Uri.file(params.absolutePath).with({
    query: `agent-code-buffer=${params.ownerId}`,
  })
  // A stale model can exist under this URI if a previous dispose path
  // leaked it; reuse rather than crash (createModel throws on duplicate
  // URIs).
  const model =
    monaco.editor.getModel(uri) ?? monaco.editor.createModel(params.text, params.monacoLangId, uri)
  if (model.getLanguageId() !== params.monacoLangId) {
    monaco.editor.setModelLanguage(model, params.monacoLangId)
  }
  replaceModelTextPreservingUndo(model, params.text)
  const entry: Entry = {
    model,
    refs: 1,
    absolutePath: params.absolutePath,
    ownerActive: true,
  }
  entries.set(params.ownerId, entry)
  return model
}

export function releaseEditorModel(ownerId: number): void {
  const entry = entries.get(ownerId)
  if (!entry) return
  entry.refs = Math.max(0, entry.refs - 1)
  // Zero viewers alone is not disposal: an inactive open tab still owns the
  // undo model. Once its final buffer owner also closes, a delayed component
  // cleanup is allowed to finish disposal here.
  disposeIfUnowned(ownerId, entry)
}

export function releaseEditorModelOwner(ownerId: number): void {
  const entry = entries.get(ownerId)
  if (!entry) return
  entry.ownerActive = false
  disposeIfUnowned(ownerId, entry)
}

/** Hygiene hook for evicting a whole project's models (e.g. if a future
 *  change trims byCwd). Not called in the steady state today. */
export function disposeAllEditorModelsUnder(rootAbs: string): void {
  const prefix = rootAbs.endsWith('/') ? rootAbs : `${rootAbs}/`
  for (const [ownerId, entry] of [...entries]) {
    if (!entry.absolutePath.startsWith(prefix)) continue
    entry.ownerActive = false
    disposeIfUnowned(ownerId, entry)
  }
}

/** Join a cwd root and store-relative path into the registry/model key.
 *  Mirrors the Global Editor store's absolutePath() join so both sides
 *  derive identical keys for the same buffer. */
export function editorModelKey(root: string, relativePath: string): string {
  return `${root.replace(/\/+$/, '')}/${relativePath.replace(/^\/+/, '')}`
}
