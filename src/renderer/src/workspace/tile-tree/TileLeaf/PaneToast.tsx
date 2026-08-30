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
export function PaneToast({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <div className="flex-shrink-0 flex justify-center px-3 py-1.5 border-t border-border bg-surface">
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
        className="toast-enter line-clamp-3 min-w-0 max-w-full rounded-control px-3 py-0.5 text-center font-code text-[11px] font-semibold text-white [overflow-wrap:anywhere] bg-accent/80"
        title={message}
      >
        {message}
      </span>
    </div>
  )
}
