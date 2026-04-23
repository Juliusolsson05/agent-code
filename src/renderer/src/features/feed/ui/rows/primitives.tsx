import type { ReactNode } from 'react'

// Layout primitives used by multiple row components.
//
// UserBand and ToolBand are horizontal "bands" that tint the full
// width of the feed column behind their children. They both use
// the same `-mx-8 px-8` negative-margin + compensating-padding
// trick: feed rows sit inside a `px-8` centered column, so a naive
// bg-color on the row would be narrower than the column's gutters
// and look like a tight card. Pulling the band out to -mx-8 and
// compensating with px-8 makes the fill edge-to-edge within the
// column while keeping the text at its original x.

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
 * Background band for tool output (Read, Grep, Edit results).
 * Subtler than UserBand — a faint step away from canvas that groups
 * tool output visually without competing with user turns or assistant
 * text. Same edge-to-edge trick as UserBand.
 */
export function ToolBand({ children }: { children: ReactNode }) {
  return (
    <div className="bg-tool-bg -mx-8 px-8 py-2">
      {children}
    </div>
  )
}
