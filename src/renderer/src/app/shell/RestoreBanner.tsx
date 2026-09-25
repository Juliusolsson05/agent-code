import { useEffect, useRef, useState } from 'react'

import { useSwapFocus } from '@renderer/lib/useSwapFocus'

import { useWorkspaceLayoutContext } from '@renderer/workspace/WorkspaceContext'

// WHY render this above TabBar instead of as a toast:
//
// The state being communicated is durable for the lifetime of the app
// run, not a transient event — autosave is disabled until the user
// restarts the app, so dismissing a toast would orphan the warning
// while the underlying disk-protection invariant is still in effect.
// A persistent banner above the tab bar matches how Electron desktop
// apps surface "this run is degraded" state (e.g. update available),
// and the user sees it on every interaction instead of having to
// remember a toast they swatted at boot.
//
// WHY the banner auto-collapses to a corner chip after 60 s (packaged-
// UX fix): the original banner permanently blocks the top ~24 px of the
// window in a degraded run, which becomes visual noise once the user has
// read it. The chip preserves the "this run is degraded" signal without
// dominating the chrome. Clicking the chip re-expands the full banner
// for a re-read; the collapsed form never hides state entirely because
// that would defeat the point of surfacing durable degradation.
const COLLAPSE_AFTER_MS = 60_000

export function RestoreBanner() {
  const workspace = useWorkspaceLayoutContext()
  const message: string | null =
    workspace.restoreStatus === 'partial-restore'
      ? 'Workspace partially restored — autosave is disabled to protect your saved state. Restart Agent Code after fixing the underlying spawn or proxy issue.'
      : workspace.restoreStatus === 'persisted-fallback'
        ? 'Could not load your saved workspace — running in a fresh-tab fallback. Autosave is disabled to avoid overwriting the on-disk file. Restart after resolving the issue.'
        : workspace.restoreStatus === 'bootstrap-error'
          ? 'Workspace bootstrap failed. Autosave is disabled. Check the dev console and restart Agent Code after fixing the underlying issue.'
          : null

  const [collapsed, setCollapsed] = useState(false)

  // Collapsing and expanding UNMOUNT the control that was just pressed, so
  // focus is carried to the counterpart (ledger G-35; useSwapFocus has the
  // WHY). The scope is the whole banner, so the 60 s auto-collapse carries
  // focus only for someone tabbed onto it, and never takes a composer's
  // caret.
  const rootRef = useRef<HTMLDivElement>(null)
  const { counterpartRef, beforeSwap } = useSwapFocus(collapsed)
  const swap = (next: boolean) => {
    beforeSwap(rootRef.current)
    setCollapsed(next)
  }

  useEffect(() => {
    if (!message) return
    // Reset any prior collapse timer whenever the message content (or
    // presence) changes — a partial→persisted transition should re-nag
    // the user for the full 60 s window.
    setCollapsed(false)
    const timer = window.setTimeout(() => swap(true), COLLAPSE_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [message])

  if (!message) return null

  if (collapsed) {
    return (
      <div ref={rootRef} className="flex justify-end px-2 py-1 flex-shrink-0">
        <button
          ref={counterpartRef}
          type="button"
          onClick={() => swap(false)}
          // The warning-soft token family (T-rules), like the CLI update
          // banner beside it; `bg-warning/10` was a raw alpha of its own.
          className="rounded-control
            inline-flex items-center gap-2 border border-warning bg-warning-soft
            px-2 py-0.5 text-[11px] font-code text-warning
            hover:bg-current/10
          "
          title="Show autosave-off details"
          aria-label="Show autosave-off details"
        >
          <span className="font-semibold uppercase tracking-wide">Autosave off</span>
          <span aria-hidden="true">▾</span>
        </button>
      </div>
    )
  }

  return (
    <div
      ref={rootRef}
      role="alert"
      className="
        flex items-start gap-3 px-3 py-2
        border-b border-warning bg-warning-soft text-warning
        text-[11px] leading-snug font-code
        flex-shrink-0
      "
    >
      <span className="font-semibold uppercase tracking-wide">Autosave off</span>
      <span className="flex-1 text-ink/90">{message}</span>
      <button
        ref={counterpartRef}
        type="button"
        onClick={() => swap(true)}
        // The CLI update banner's action grammar (a current-colour bordered
        // control), so the two degraded-state banners stacked above the tab
        // bar read as one family. Hide was bare tinted text with no border.
        className="rounded-control border border-current px-2 py-0.5 text-[10px] uppercase tracking-wide hover:bg-current/10"
        title="Collapse into a corner chip (press the chip to expand it again)"
        aria-label="Collapse autosave-off banner"
      >
        Hide
      </button>
    </div>
  )
}
