import type { SessionId } from '@renderer/workspace/types'

// Enumerate the code blocks currently rendered in one pane's feed,
// in document (top-to-bottom) order.
//
// WHY DOM-based and not transcript-based:
//   Code blocks have no transcript identity (see the note on
//   `codeBlockPicker` in workspaceState.ts). They are produced by
//   markdown rendering, by per-tool rows, by the streaming Write
//   preview — there is no single data structure to walk. The only
//   place the ordered, deduplicated list of "code blocks the user
//   can currently see" exists is the rendered DOM. Every `CodeBlock`
//   stamps `data-code-block-id` on its root, so a scoped
//   `querySelectorAll` IS the list.
//
// WHY scoped to a single pane:
//   The grid can show several panes at once, each with its own feed.
//   The Copy Code Block picker is a per-pane command (it acts on the
//   focused pane), so we anchor the query at that pane's root —
//   `[data-pane-id="<sessionId>"]`, the same stable hook the dispatch
//   layout and HTML debug panel already rely on.
//
// Returns [] when the pane is not mounted or has no code blocks.
export function enumerateCodeBlockIds(sessionId: SessionId): string[] {
  // sessionIds are uuid/`resume-…`-shaped (no quotes), so direct
  // interpolation into the attribute selector is safe — this mirrors
  // the existing `[data-pane-id="…"]` lookups elsewhere in the app.
  const pane = document.querySelector(`[data-pane-id="${sessionId}"]`)
  if (!pane) return []
  const nodes = pane.querySelectorAll<HTMLElement>('[data-code-block-id]')
  const ids: string[] = []
  for (const node of nodes) {
    const id = node.getAttribute('data-code-block-id')
    if (id) ids.push(id)
  }
  return ids
}
