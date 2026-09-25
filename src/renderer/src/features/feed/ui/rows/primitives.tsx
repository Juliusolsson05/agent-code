import type { ReactNode, Ref } from 'react'

// Layout primitives used by multiple row components.
//
// UserBand is the only horizontal background band in committed chat
// rows. Tool rows deliberately render without a matching band: the
// live semantic plane already gives tools enough structure through
// markers, file headers, and diff slabs, and committed edit/write rows
// should look like the streaming patch surface they replace.

/**
 * Shared class for inline disclosure controls ("… more output",
 * previous/next paging, "view paged content", "collapse", "copy").
 *
 * WHY this exists: every one of these controls was born as
 * `text-[11px] text-muted hover:text-ink cursor-pointer` — a hover-era
 * affordance with an ~14px hit area. On the phone (and on any touch
 * device) that is far below the 44pt guidance and the worst offenders
 * sit INSIDE expanded tool output, where a mis-tap scrolls the feed
 * instead of paging. The class grows only the HIT AREA (min-h + x
 * padding + negative-x margin so visual alignment is pixel-identical)
 * and adds a pressed state; typography stays exactly as dense as the
 * desktop designed it. Desktop visuals do not change — the padding is
 * invisible on text that already occupied the line.
 */
export const feedDisclosureClass =
  'inline-flex items-center min-h-[44px] px-1 -mx-1 text-[11px] text-muted hover:text-ink active:text-ink cursor-pointer select-none'

/**
 * UserBand — a horizontal highlight band that sits behind a *user
 * prompt* so real user turns are easy to spot when scanning a long
 * feed. Only ever wraps text content that originated as a user prompt.
 * Never wraps tool_result output (even though tool_result blocks live
 * under role='user' on the wire) — see the comment in ConversationRow.
 */
/**
 * The feed's previous / next pair for paged tool output (code blocks, long
 * text, multi-edit chunks).
 *
 * WHY both buttons stay MOUNTED and an end is `aria-disabled` (ledger G-36):
 * the three pagers each rendered a button only while it had somewhere to go.
 * Pressing "next" onto the last page therefore unmounted the button under
 * the keyboard user's focus. Focus fell to <body>, and the next Tab restarted
 * from the top of the whole document, far from the output being read.
 * `disabled` would not help: a disabled button drops focus the same way.
 * `aria-disabled` keeps it focusable and announced as unavailable, and the
 * click is a no-op.
 *
 * `nextRef` lets an opener (a code block's "view paged content") hand focus
 * to the pager it just revealed.
 */
export function FeedPagerButtons({ hasPrevious, hasNext, onPrevious, onNext, nextRef }: {
  hasPrevious: boolean
  hasNext: boolean
  onPrevious: () => void
  onNext: () => void
  nextRef?: Ref<HTMLButtonElement>
}) {
  const end = 'aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:text-muted'
  return (
    <>
      <button
        type="button"
        className={`${feedDisclosureClass} ${end}`}
        aria-disabled={!hasPrevious || undefined}
        onClick={() => { if (hasPrevious) onPrevious() }}
      >
        previous
      </button>
      <button
        ref={nextRef}
        type="button"
        className={`${feedDisclosureClass} ${end}`}
        aria-disabled={!hasNext || undefined}
        onClick={() => { if (hasNext) onNext() }}
      >
        next
      </button>
    </>
  )
}

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
