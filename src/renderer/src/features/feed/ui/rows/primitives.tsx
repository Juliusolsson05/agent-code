import type { ReactNode } from 'react'

// Layout primitives used by multiple row components.
//
// UserBand is the only horizontal background band left in committed
// chat rows. Tool rows used to share the same full-width tint through
// ToolBand, but that made completed Edit/Write/apply_patch surfaces
// read as a separate gray block after the fact. The live semantic
// plane already gives tools enough structure through markers, file
// headers, and diff slabs; committed rows should stay visually calm
// and not add a second "tool background" wrapper.

/**
 * UserBand — a horizontal highlight band that sits behind a *user
 * prompt* so real user turns are easy to spot when scanning a long
 * feed. Only ever wraps text content that originated as a user prompt.
 * Never wraps tool_result output (even though tool_result blocks live
 * under role='user' on the wire) — see the comment in ConversationRow.
 */
export function UserBand({ children }: { children: ReactNode }) {
  return (
    <div className="bg-user-bg -mx-8 px-8 py-3">
      {children}
    </div>
  )
}

/**
 * Tool wrapper kept as a named primitive because many provider rows
 * depend on it for ownership boundaries. It intentionally does NOT
 * paint a background anymore: the 2026-05-16 custom-rendering pass
 * found that the light gray committed-tool band made Claude and Codex
 * edits feel heavier than assistant text and visually duplicated the
 * inner diff/code panels. Keeping only vertical padding preserves row
 * rhythm without the full-width gray slab.
 */
export function ToolBand({ children }: { children: ReactNode }) {
  return (
    <div className="py-2">
      {children}
    </div>
  )
}
