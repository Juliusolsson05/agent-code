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
    // WHY var-tracked bleed: the band must extend edge-to-edge across the
    // scroller on every container width, but the feed column's gutter has
    // been container-relative since the 2026-07-08 mobile-feed-rewrite
    // (12px under 480px, 20px to 768px, 32px above). The historical
    // hardcoded -mx-8/px-8 mirror bled 20px past the viewport on each side
    // at phone widths and made the entire feed horizontally scrollable —
    // the worst "no real padding" defect. The var is set on the feed column
    // (.feed-column in styles.css) at the SAME breakpoints the column's
    // px-* utilities use, so ≥768px output stays pixel-identical to the old
    // classes (32px == px-8; regression invariant for the desktop). The 0px
    // fallback means a band rendered outside a feed column loses its bleed
    // instead of overflowing — the safe failure direction.
    <div className="bg-user-bg py-3 -mx-[var(--feed-gutter,0px)] px-[var(--feed-gutter,0px)]">
      {children}
    </div>
  )
}
