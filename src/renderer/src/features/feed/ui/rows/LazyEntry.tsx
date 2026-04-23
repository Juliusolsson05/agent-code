import { memo, useEffect, useRef, useState, type ReactNode } from 'react'

// ---------------------------------------------------------------------------
// Lazy entry mounting — the key to rendering fat conversations.
// ---------------------------------------------------------------------------
//
// Problem: a resumed session can have 200+ entries. Mounting all of them
// at once means 200 ReactMarkdown parses + CodeBlock syntax highlights
// in a single blocking render pass. That's multiple seconds of frozen UI,
// and the DOM ends up with thousands of nodes the browser has to lay out
// even though the user only sees the bottom ~20 entries.
//
// Solution: entries in the last EAGER_TAIL positions render immediately
// (they're in/near the viewport). Everything above starts as a thin
// placeholder div. An IntersectionObserver watches each placeholder and
// swaps in the real content when the user scrolls up to it. Once
// mounted, the entry stays mounted forever — React.memo keeps
// subsequent re-renders free, and we avoid the re-parse cost that full
// virtualization (unmount→remount on scroll) would cause.
//
// Why not full virtualization (react-window / tanstack-virtual):
//   - Our entry count is low hundreds, not tens of thousands.
//   - Virtualization unmounts rows that scroll out of view. Re-mounting
//     means re-parsing markdown (React.memo doesn't survive unmount).
//     We'd need a separate parsed-output cache. Complexity for no gain.
//   - Variable row heights (user prompt = 1 line, assistant with code
//     blocks = 500px+) make fixed-size virtualizers useless and
//     measured-height virtualizers finicky.
//   - The streaming row at the bottom grows continuously during
//     generation. Virtualizers don't handle a row whose height changes
//     every frame well.
//
// The EAGER_TAIL count is generous: 30 entries covers roughly 2-3
// screenfuls so the user never sees a placeholder flash on initial
// load or on tab-switch restore. Scrolling up past the eager zone
// triggers lazy mount with a 200px rootMargin (entries mount one
// screenful before they're visible), so the user never sees the swap.

export const EAGER_TAIL = 30

/**
 * Wraps a single feed entry. If `eager` is true, renders children
 * immediately. Otherwise, renders a placeholder and waits for the
 * IntersectionObserver to fire before mounting the real content.
 *
 * Once mounted, stays mounted permanently — the `mounted` state only
 * transitions false→true, never back. This is load-bearing: unmounting
 * would discard React.memo's cached render tree and force a full
 * re-parse of the entry's markdown on the next scroll-into-view.
 */
export const LazyEntry = memo(function LazyEntry({
  eager,
  suspended = false,
  scrollerRef,
  children,
}: {
  eager: boolean
  // True while the owning session is in a bootstrap burst. Suspends
  // observer attachment so 200 placeholders don't all mount at once
  // during a resume replay. Feed re-enables by flipping this back to
  // false after the bootstrap debounce clears (see Feed's
  // prevBootstrappingRef pin-once effect for the scroll pairing).
  suspended?: boolean
  scrollerRef: React.RefObject<HTMLDivElement | null>
  children: ReactNode
}) {
  const [mounted, setMounted] = useState(eager)
  const placeholderRef = useRef<HTMLDivElement>(null)

  // If this entry starts lazy but later falls into the eager zone
  // (e.g. entries above it were filtered out, shrinking the list),
  // mount it immediately.
  useEffect(() => {
    if (eager && !mounted) setMounted(true)
  }, [eager, mounted])

  useEffect(() => {
    if (mounted) return
    // While the owning session is in a bootstrap burst, don't attach
    // the observer. Without this guard a resume replay pins to the
    // bottom and every placeholder within rootMargin flips mounted in
    // the same render — a cascade that's the actual "scrolling
    // through the whole conversation" symptom. Once the parent clears
    // `suspended`, Feed's pin-once effect lands us at the bottom and
    // normal scroll-triggered mounts take over from there.
    if (suspended) return
    const el = placeholderRef.current
    if (!el) return

    // Use the scroll container as the intersection root so the
    // observer fires relative to the visible scroll area, not the
    // document viewport. rootMargin adds 200px of lookahead above
    // the viewport so entries mount before the user scrolls to them
    // — no visible placeholder flash.
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setMounted(true)
          observer.disconnect()
        }
      },
      { root: scrollerRef.current, rootMargin: '200px 0px 200px 0px' },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [mounted, suspended, scrollerRef])

  if (!mounted) {
    // Placeholder: a fixed-height div that approximates a typical
    // entry. The exact height doesn't matter much — it just needs to
    // be non-zero so the scroll container has enough height for the
    // IntersectionObserver to fire as the user scrolls. Once the real
    // content mounts, it takes its natural height and the scrollbar
    // adjusts. The 48px estimate is conservative (a single-line tool
    // result or system row). Taller entries will cause a small layout
    // shift on mount, but that happens off-screen (200px above the
    // viewport) so the user never sees it.
    return <div ref={placeholderRef} className="min-h-[48px]" />
  }

  return <>{children}</>
})
