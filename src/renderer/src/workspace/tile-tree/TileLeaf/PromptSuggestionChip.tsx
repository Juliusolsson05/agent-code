type Props = {
  text: string
  /** Apply the suggestion — prefill the composer draft with this text. */
  onApply: (text: string) => void
  /** Dismiss without applying. */
  onDismiss: () => void
}

// Ephemeral next-prompt suggestion chip (issue #174). Deliberately visually
// distinct from a chat row — it is an OFFER about what to type next, not a
// message. Clicking the body prefills the composer; the ✕ dismisses it. The
// parent (ComposerInput) owns when it renders and clears it on apply /
// dismiss / submit / next turn, so this component is pure-presentational and
// renders nothing for an empty suggestion.
export function PromptSuggestionChip({ text, onApply, onDismiss }: Props) {
  if (!text) return null
  return (
    <div className="flex items-center gap-1 px-2 pb-1">
      <button
        type="button"
        onClick={() => onApply(text)}
        className="
          flex items-center gap-1.5 max-w-full truncate
          px-2 py-1 text-[11px] font-code text-ink-dim
          border border-border bg-surface
          hover:text-ink hover:border-border-hi
        "
        title="Use this suggestion"
      >
        <span className="text-muted">↵</span>
        <span className="truncate">{text}</span>
      </button>
      <button
        type="button"
        aria-label="Dismiss suggestion"
        onClick={onDismiss}
        className="px-1 text-[11px] text-muted hover:text-ink"
      >
        ✕
      </button>
    </div>
  )
}
