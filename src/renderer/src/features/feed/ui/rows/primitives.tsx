import type { ReactNode } from 'react'

// Layout primitives used by multiple row components.
//
// UserBand is the only horizontal background band in committed chat
// rows. Tool rows deliberately render without a matching band: the
// live semantic plane already gives tools enough structure through
// markers, file headers, and diff slabs, and committed edit/write rows
// should look like the streaming patch surface they replace.

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
