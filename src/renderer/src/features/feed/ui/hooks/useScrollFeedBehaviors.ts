import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

import { scrollPositions } from '@renderer/features/feed/scroll'
import type { ScrollInfo } from '@renderer/features/feed/types'

// PORTED VERBATIM from Feed.tsx @269f9fc — the entire scroll-behavior
// family: mount restore (:393-421), the scroll listener (:436-506),
// sticky-bottom auto-scroll (:527-541), the bootstrap pin-once
// transition (:549-574), and scroll-to-latest (:712-728). This logic
// is scarred production code; every WHY comment travelled with it.
// Read them before changing ANYTHING here.
//
// WHY one hook and not five: these effects share five refs
// (stickyBottom, lastScrollTop, hadSavedPositionOnMount, loadingOlder,
// prevBootstrapping) whose lifecycles are one story — "where is the
// user in the scroller and did they put themselves there". Splitting
// per-effect would force a ref-bag argument that obscures the port
// and invites drift between the halves. The plan's
// useStickyBottom/useScrollPersistence/useOlderHistory decomposition
// lives as the section headers below instead.

export function useScrollFeedBehaviors({
  scrollerRef,
  sessionId,
  tailMode,
  bootstrapping,
  entriesLength,
  semanticTurnSignal,
  semanticHistorySignal,
  hasOlderHistory,
  loadingOlderHistory,
  onLoadOlderHistory,
  onScrollInfo,
  scrollToLatestRequest,
  cancelPickerTween,
}: {
  scrollerRef: RefObject<HTMLDivElement | null>
  sessionId: string
  tailMode: boolean
  bootstrapping: boolean
  entriesLength: number
  semanticTurnSignal: string
  semanticHistorySignal: string
  hasOlderHistory: boolean
  loadingOlderHistory: boolean
  onLoadOlderHistory?: () => Promise<void>
  onScrollInfo?: (info: ScrollInfo) => void
  scrollToLatestRequest: number
  /** From usePickerAutoScroll — scroll-to-latest must cancel an
   *  in-flight picker tween before snapping (the tween would fight
   *  the snap for the next 180ms otherwise). */
  cancelPickerTween: () => void
}): void {
  // Restore stickyBottom from the persisted map on first render so
  // the auto-scroll effect below makes the right decision without
  // needing to wait for the scroll listener to run. Defaults to
  // true for brand-new sessions (no saved position yet).
  const stickyBottomRef = useRef(
    scrollPositions.get(sessionId)?.stickyBottom ?? true,
  )
  const loadingOlderRef = useRef(false)
  // Was there an existing saved scroll position for this session when
  // this Feed instance mounted? Used to distinguish "restore the
  // user's deliberate scrolled-up position" from "brand-new/resumed
  // session should land at latest content even if stickyBottom got
  // transiently knocked false during bootstrap."
  const hadSavedPositionOnMountRef = useRef(scrollPositions.has(sessionId))
  // Previous scrollTop, used to distinguish "the user started
  // scrolling upward" from incidental near-bottom jitter. This is
  // load-bearing during active turns: with the old "gap < 48"
  // heuristic alone, a tiny upward wheel tick still counted as
  // sticky, and the next ~60 Hz screen update snapped the feed right
  // back down before the user could accumulate enough distance to
  // escape. Any real upward movement should break follow
  // immediately; re-follow only when the user intentionally returns
  // near the bottom.
  const lastScrollTopRef = useRef(0)

  // ---- useScrollPersistence: mount restore -------------------------
  // Restore the saved scroll position on mount — synchronously, via
  // useLayoutEffect, so the browser never paints the scroller at
  // scrollTop=0 before we restore. Using useEffect here would flash
  // the top of the feed for one frame before the restore landed.
  //
  // Three cases:
  //   1. No saved entry → first mount for this session. Default to
  //      "stuck at bottom" — a freshly-opened feed should show the
  //      most recent content, like opening a terminal or chat window.
  //   2. Saved stickyBottom: true → user was at the bottom when they
  //      left. Content may have grown while unmounted, so pin to the
  //      NEW scrollHeight, not the old scrollTop.
  //   3. Saved stickyBottom: false → restore the exact saved
  //      scrollTop. Content height on remount matches save time.
  //
  // The sessionId dep is load-bearing: if the user resumes a different
  // session in the same pane slot, we re-restore from the new key.
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    hadSavedPositionOnMountRef.current = scrollPositions.has(sessionId)
    if (tailMode) {
      el.scrollTop = el.scrollHeight
      stickyBottomRef.current = true
      lastScrollTopRef.current = el.scrollTop
      return
    }
    const saved = scrollPositions.get(sessionId)
    if (!saved || saved.stickyBottom) {
      // Case 1 or 2: pin to bottom, synchronously in useLayoutEffect
      // so the scrollTop change commits in the SAME paint as the
      // initial content render. Without that, the first paint shows
      // scrollTop=0 and the next tick scrolls down — a visible
      // "starts at top, jumps to bottom" flash on every tab switch.
      el.scrollTop = el.scrollHeight
      stickyBottomRef.current = true
      lastScrollTopRef.current = el.scrollTop
    } else {
      // Case 3: restore exact position.
      el.scrollTop = saved.scrollTop
      stickyBottomRef.current = false
      lastScrollTopRef.current = el.scrollTop
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollerRef is a stable ref
  }, [sessionId, tailMode])

  // ---- useStickyBottom: the scroll listener ------------------------
  // One scroll listener for the container. Updates stickyBottomRef
  // imperatively AND persists the position into the module-level map
  // so a later unmount/remount can restore it.
  //
  // CRITICAL: we DO NOT call onScroll() synchronously on mount. That
  // was the original bug — at mount time the scroller has scrollTop=0
  // and scrollHeight=full-content, so gap > 48 and the handler would
  // stamp stickyBottom=false INTO THE REF AND THE PERSISTED MAP before
  // the layout effect above had a chance to scroll to the bottom. The
  // layout effect sets stickyBottomRef explicitly; the scroll listener
  // only reacts to actual user scrolls.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const onScroll = () => {
      if (tailMode) {
        el.scrollTop = el.scrollHeight
        stickyBottomRef.current = true
        lastScrollTopRef.current = el.scrollTop
        scrollPositions.set(sessionId, {
          scrollTop: el.scrollTop,
          stickyBottom: true,
        })
        if (onScrollInfo) onScrollInfo({ fraction: 0 })
        return
      }
      const gap = el.scrollHeight - (el.scrollTop + el.clientHeight)
      const scrollingUp = el.scrollTop < lastScrollTopRef.current
      const nearBottom = gap < 48
      stickyBottomRef.current =
        scrollingUp && gap > 0 ? false : nearBottom
      lastScrollTopRef.current = el.scrollTop
      scrollPositions.set(sessionId, {
        scrollTop: el.scrollTop,
        stickyBottom: stickyBottomRef.current,
      })
      // Push scroll position to parent for the scroll indicator.
      // fraction=0 at bottom, fraction=1 at top.
      if (onScrollInfo) {
        const maxScroll = el.scrollHeight - el.clientHeight
        const fraction = maxScroll > 0
          ? 1 - (el.scrollTop / maxScroll)
          : 0
        onScrollInfo({ fraction })
      }

      // ---- useOlderHistory: top-edge load trigger ------------------
      if (
        el.scrollTop < 160 &&
        hasOlderHistory &&
        !loadingOlderHistory &&
        !loadingOlderRef.current &&
        !tailMode &&
        onLoadOlderHistory
      ) {
        loadingOlderRef.current = true
        const beforeHeight = el.scrollHeight
        const beforeTop = el.scrollTop
        void onLoadOlderHistory()
          .then(() => {
            requestAnimationFrame(() => {
              const next = scrollerRef.current
              if (!next) return
              const delta = next.scrollHeight - beforeHeight
              next.scrollTop = beforeTop + Math.max(0, delta)
              lastScrollTopRef.current = next.scrollTop
            })
          })
          .finally(() => {
            loadingOlderRef.current = false
          })
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollerRef is a stable ref
  }, [
    sessionId,
    onScrollInfo,
    tailMode,
    hasOlderHistory,
    loadingOlderHistory,
    onLoadOlderHistory,
  ])

  // ---- useStickyBottom: auto-scroll on content changes -------------
  // Only when sticky. If the user is scrolled up, skip — they're
  // reading earlier content and we don't want to yank them back.
  //
  // The semantic signals are cheap fingerprints (turnId + per-block
  // content lengths + status — see semanticTurnScrollSignal) so this
  // effect re-runs when semantic deltas land, not only when committed
  // entries append. It is a scroll-invalidation token only.
  useEffect(() => {
    // During a bulk bootstrap burst we skip per-append auto-scroll.
    // The pin-once-on-transition effect below lands us at the bottom
    // in a single operation after the burst ends — otherwise every
    // entry appended during the burst would pin-scroll and wake up
    // the LazyEntry observer cascade. See docs/superpowers/plans/
    // 2026-04-15-bootstrap-replay-perf.md.
    if (bootstrapping) return
    if (!tailMode && !stickyBottomRef.current) return
    // scrollTop = scrollHeight pins to bottom without the smooth-scroll
    // overshoot scrollIntoView sometimes produces. Direct, instant,
    // no animation frames.
    const el = scrollerRef.current
    if (el) el.scrollTop = el.scrollHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollerRef is a stable ref
  }, [entriesLength, tailMode, semanticTurnSignal, semanticHistorySignal, bootstrapping])

  // ---- Pin-once on the bootstrap → live transition ------------------
  // Runs exactly once per transition thanks to the previous-value ref.
  // No dependency on entriesLength so the effect does not fire on
  // subsequent live appends — those go through the regular auto-scroll
  // effect above.
  const prevBootstrappingRef = useRef(false)
  useEffect(() => {
    if (prevBootstrappingRef.current && !bootstrapping) {
      const el = scrollerRef.current
      // Fresh/resumed sessions with no saved scroll position should
      // ALWAYS land on the latest content after the bootstrap burst.
      // Relying purely on stickyBottomRef here is fragile because the
      // initial mount/placeholder/lazy-load sequence can transiently
      // mark the feed non-sticky before the first real user scroll.
      // That leaves the viewport stranded above the eager tail: the
      // exact "blank until I scroll down a couple pages" symptom.
      const shouldForceInitialBottom =
        !hadSavedPositionOnMountRef.current && !tailMode
      if (el && (tailMode || stickyBottomRef.current || shouldForceInitialBottom)) {
        el.scrollTop = el.scrollHeight
        stickyBottomRef.current = true
        lastScrollTopRef.current = el.scrollTop
        scrollPositions.set(sessionId, {
          scrollTop: el.scrollTop,
          stickyBottom: true,
        })
        if (onScrollInfo) onScrollInfo({ fraction: 0 })
      }
    }
    prevBootstrappingRef.current = bootstrapping
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollerRef is a stable ref
  }, [bootstrapping, onScrollInfo, sessionId, tailMode])

  // ---- Scroll-to-latest (explicit user request) ----------------------
  useEffect(() => {
    if (scrollToLatestRequest === 0) return
    const el = scrollerRef.current
    if (!el) return
    cancelPickerTween()
    el.scrollTop = el.scrollHeight
    stickyBottomRef.current = true
    lastScrollTopRef.current = el.scrollTop
    scrollPositions.set(sessionId, {
      scrollTop: el.scrollTop,
      stickyBottom: true,
    })
    if (onScrollInfo) onScrollInfo({ fraction: 0 })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scrollerRef/canceller are stable
  }, [onScrollInfo, scrollToLatestRequest, sessionId])
}
