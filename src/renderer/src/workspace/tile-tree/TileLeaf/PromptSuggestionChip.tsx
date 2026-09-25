import { Kbd } from '@renderer/components/ui/kbd'

type Props = {
  text: string
  /** Apply the suggestion — prefill the composer draft with this text. */
  onApply: (text: string) => void
  /** Dismiss without applying. */
  onDismiss: () => void
  /** True while Tab would fill the composer with it (the draft is empty).
   *  Drives the Tab hint, which must appear only when the key really acts. */
  tabFills?: boolean
}

// Ephemeral next-prompt suggestion chip (issue #174). Deliberately visually
// distinct from a chat row — it is an OFFER about what to type next, not a
// message. Clicking the body SENDS it (TileLeaf's auto-send); Tab on an empty
// draft FILLS the composer with it (useComposerKeybinds); × dismisses it. The
// parent (ComposerInput) owns when it renders and clears it on apply /
// dismiss / submit / next turn, so this component is pure-presentational and
// renders nothing for an empty suggestion.
//
// KEY HINTS (plan H2, UI pass): the chip used to lead with "↵", which taught
// Enter, and Enter never touched the suggestion. The honest hints are "⇥ fill"
// (shown only while the draft is empty, the one time Tab does it) and the
// body's accessible name, which says a click sends. The dismiss glyph is the
// app's × (it was ✕, the only one in the app).
export function PromptSuggestionChip({ text, onApply, onDismiss, tabFills = false }: Props) {
  if (!text) return null
  return (
    <div className="flex items-center gap-1 px-2 pb-1">
      <button
        type="button"
        onClick={() => onApply(text)}
        className="rounded-control
          flex items-center gap-1.5 max-w-full truncate
          px-2 py-1 text-[11px] font-code text-ink-dim
          border border-border bg-surface
          outline-none hover:text-ink hover:border-border-hi
          focus-visible:ring-1 focus-visible:ring-focus-ring
        "
        aria-label={`Send suggestion: ${text}`}
        title="Send this suggestion"
      >
        <span className="truncate">{text}</span>
      </button>
      {tabFills ? (
        <span className="flex flex-shrink-0 items-center gap-1 text-[10px] text-muted">
          <Kbd binding="Tab" />
          fill
        </span>
      ) : null}
      <button
        type="button"
        aria-label="Dismiss suggestion"
        onClick={onDismiss}
        className="rounded-control px-1 text-[13px] leading-none text-muted outline-none hover:text-ink focus-visible:ring-1 focus-visible:ring-focus-ring"
      >
        ×
      </button>
    </div>
  )
}
