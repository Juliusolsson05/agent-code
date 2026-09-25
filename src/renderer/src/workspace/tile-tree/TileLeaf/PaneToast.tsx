// Pane toast — transient single-slot feedback (e.g. "Copied to
// clipboard"). Renders above the composer so it's contextually tied
// to this pane, not floating over the feed content. Auto-dismissed
// by the store timeout; we just render when non-null.
//
// The `toast-enter` class is a keyframed fade+slide-in animation
// declared in styles.css; it runs once per fresh toast text.
// Because the component is gated on truthy `message`, React
// unmounts+remounts the node when the message flips from null →
// value → null, which restarts the animation cleanly.
import { PANE_DIALOG_LAYERS, PANE_FEEDBACK_ATTRIBUTE } from '@renderer/components/ui/pane-dialog'
import { cn } from '@renderer/lib/utils'

export function PaneToast({ message }: { message: string | null }) {
  // A LIVE REGION that is always mounted (plan N17): a region that appears
  // together with its text is not announced by screen readers — the region
  // must exist before its content changes. When there is no message it
  // collapses to sr-only, so the pane gains no height.
  //
  // The feedback attribute keeps this region OUT of an open pane prompt's
  // inert pass (Claude review of #1221, reviewer B F2): inert content leaves
  // the accessibility tree, which silenced the announcement, and blocks the
  // pointer, which killed the clipped text's hover title.
  const feedback = { [PANE_FEEDBACK_ATTRIBUTE]: '' }
  if (!message) return <div role="status" aria-live="polite" className="sr-only" {...feedback} />
  return (
    // `relative` + the feedback layer: readable ABOVE a pane-scoped condition
    // dialog's scrim (#713; see PANE_DIALOG_LAYERS). It is harmless when no
    // dialog is up, since nothing else in the pane is stacked.
    <div {...feedback} role="status" aria-live="polite" className={cn('relative flex-shrink-0 flex justify-center px-3 py-1.5 border-t border-border bg-surface', PANE_DIALOG_LAYERS.feedback)}>
      {/* WHY this deliberately borrows the modest chrome radius even though
          the status itself is not interactive: PaneToast is embedded between
          bordered pane regions, with no shadow or scrim. `rounded-float`
          falsely classified it as detached and its 14px Round value clamped
          against this short line box into an almost complete pill. GlobalToast
          remains the true detached-toast owner of the float token.

          WHY the emergency wrap and line cap belong here rather than at each caller:
          pane toasts intentionally carry full bundle paths, resume commands,
          and backend errors. Any one can contain a token wider than a split
          pane, so the shared presentation must be the containment boundary.
          Wrapping alone is not sufficient: this wrapper is a non-shrinking
          child above the composer, and an uncapped error could turn into
          hundreds of lines and push the composer outside a short split pane.
          Three lines keep the feedback useful without letting it repossess
          the pane; the full DOM text remains available to assistive tech and
          `title` preserves mouse inspection of the clipped remainder. */}
      <span
        className="toast-enter line-clamp-3 min-w-0 max-w-full rounded-control px-3 py-0.5 text-center font-code text-[11px] font-semibold text-accent-fg [overflow-wrap:anywhere] bg-accent/80"
        title={message}
      >
        {message}
      </span>
    </div>
  )
}
