// Code-block source registry.
//
// WHY this exists:
//   The "Copy Code Block…" picker needs the EXACT source text of a
//   selected code block. Reading it back out of the DOM is unreliable:
//   a static (highlight.js) block's `textContent` mostly reconstructs
//   the source, but a Monaco-engine block (`engine="monaco"`, used for
//   some tool results) renders its text on a canvas/virtualized layer
//   with no plain text node at all — `textContent` there is empty.
//   And even for static blocks, `textContent` blurs the trailing-
//   newline question and any zero-width markup highlight.js injects.
//
//   So instead every `CodeBlock` registers its own `code` prop here,
//   keyed by its unique instance id (the `data-code-block-id` it also
//   stamps on its root node). The picker enumerates ids from the DOM
//   (document order, scoped to a pane) and looks the source up here.
//
// WHY a module-scope Map and not React context:
//   The ids are globally unique (`useId()`), so there is no scoping
//   problem — a lookup only ever uses an id the caller already found
//   in a pane-scoped DOM query. A plain Map avoids threading a
//   provider through the whole feed tree just to register a string.
//
// LIFECYCLE INVARIANT: a CodeBlock MUST `register` on mount and
// `unregister` on unmount (and re-register when its `code` changes,
// e.g. the streaming Write preview). A leaked entry is not fatal —
// the picker only ever reads ids that are currently in the DOM — but
// it is a slow memory leak, so the unmount cleanup is load-bearing.

const codeById = new Map<string, string>()

export function registerCodeBlock(id: string, code: string): void {
  codeById.set(id, code)
}

export function unregisterCodeBlock(id: string): void {
  codeById.delete(id)
}

export function getCodeBlockCode(id: string): string | null {
  return codeById.has(id) ? (codeById.get(id) as string) : null
}
