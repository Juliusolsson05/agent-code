import { useEffect } from 'react'

// Scaffold — the phone app's root layout column, and the single owner of
// keyboard-driven viewport compensation.
//
// WHY THIS EXISTS: iOS Safari keeps the LAYOUT viewport at window height
// when the on-screen keyboard opens; only window.visualViewport shrinks.
// A flex column pinned to `height: 100%` therefore kept the composer and
// the conditions band positioned below the visible area while the user
// typed — they had to blur the input to see what they were answering.
// (Android Chrome is covered by the interactive-widget=resizes-content
// meta added alongside this component; iOS ignores that meta, so we
// compensate here.)
//
// Mechanism: subscribe to visualViewport resize/scroll and write the
// CURRENT visible height into --app-visible-height on <html>. styles.css
// sizes .app with `height: var(--app-visible-height, 100dvh)`, so before
// JS runs (and on desktop browsers where visualViewport === window) the
// 100dvh default holds — a shrinking dvh under browser chrome is already
// the correct behavior there, and the var simply tracks it once alive.
//
// rAF-throttled because iOS fires these events at keyboard-animation
// framerate (60/s); layout per event would jank the very animation the
// user is watching. Scroll events matter too: iOS reports a smaller
// visual viewport AND an offset while the keyboard animates, and only
// the final settled size is the one worth committing.

export function Scaffold({ children }: { children: React.ReactNode }): React.JSX.Element {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return undefined

    let frame = 0
    const apply = () => {
      frame = 0
      document.documentElement.style.setProperty('--app-visible-height', `${vv.height}px`)
    }
    const onViewportChange = () => {
      if (frame) return
      frame = window.requestAnimationFrame(apply)
    }

    vv.addEventListener('resize', onViewportChange)
    vv.addEventListener('scroll', onViewportChange)
    // Prime once immediately so a phone that connects with the keyboard
    // ALREADY open (session restore into a focused draft) starts correct
    // instead of waiting for the next resize.
    apply()

    return () => {
      if (frame) window.cancelAnimationFrame(frame)
      vv.removeEventListener('resize', onViewportChange)
      vv.removeEventListener('scroll', onViewportChange)
      document.documentElement.style.removeProperty('--app-visible-height')
    }
  }, [])

  // Effect-only component: the screens below already own their `.app`
  // column (styles.css sizes it off the var this effect publishes), so
  // adding a wrapper div here would nest two height-constrained columns —
  // the inner one re-applying 100dvh inside the outer's visible height.
  return <>{children}</>
}
