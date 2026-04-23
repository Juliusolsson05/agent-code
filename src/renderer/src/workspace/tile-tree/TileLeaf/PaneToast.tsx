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
      <span className="toast-enter text-[11px] font-code text-white font-semibold bg-accent/80 px-3 py-0.5">
        {message}
      </span>
    </div>
  )
}
