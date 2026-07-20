import type { SessionId } from '@renderer/workspace/types'

// The DOM anchor that declares "text inside here is quotable, and it
// belongs to this session".
//
// WHY a dedicated attribute instead of reusing `data-pane-id`:
//   `data-pane-id` (TileLeaf.tsx) wraps the WHOLE pane — header, feed,
//   AND composer. Scoping selection capture to it would treat text the
//   user selected inside their own composer as quotable feed content,
//   which is nonsense: you would quote your own half-written prompt
//   back into itself.
//
//   The second reason is Reader Mode. Reader Mode is a full takeover —
//   MainSurface renders ReaderView *instead of* the workspace shell, so
//   no TileLeaf and therefore no `data-pane-id` exists there at all
//   (see the comment at TileLeaf.tsx:172-174). With a dedicated
//   attribute, Reader Mode joins the feature by stamping one attribute
//   rather than growing a parallel capture path.
//
// INVARIANT: every element carrying this attribute must contain ONLY
// content that makes sense to quote back to the agent. Pane chrome,
// composers, headers, and toolbars must stay outside it. Widening a
// scope is how this feature starts quoting UI labels.
export const QUOTE_SCOPE_ATTR = 'data-quote-scope'

/**
 * Walk up from a selection anchor to the session whose feed it lives in.
 *
 * Returns null when the node is outside every quote scope — which is the
 * normal, expected answer for a click in the composer, in the command
 * palette, or anywhere in app chrome. Callers MUST treat null as "not a
 * quotable selection", never as an error.
 */
export function resolveQuoteScope(node: Node | null): SessionId | null {
  if (!node) return null

  // Text nodes have no `closest`, so climb to the nearest element first.
  // A selection anchor inside rendered markdown is almost always a text
  // node, so this is the common path, not the edge case.
  const element = node.nodeType === Node.ELEMENT_NODE
    ? (node as Element)
    : node.parentElement

  const scope = element?.closest(`[${QUOTE_SCOPE_ATTR}]`)
  const sessionId = scope?.getAttribute(QUOTE_SCOPE_ATTR)
  return sessionId && sessionId.length > 0 ? (sessionId as SessionId) : null
}
