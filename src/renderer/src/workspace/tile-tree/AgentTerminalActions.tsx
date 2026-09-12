import type { JSX } from 'react'

// AgentTerminalActions — pointer-clickable Submit for raw agent terminals,
// shown only in Mouse Mode, the terminal-view sibling of ComposerActions.
//
// WHY it exists: AgentTerminalLeaf is a pure PTY view with no composer and no
// draft, so the one thing a mouse-only user is missing is the final Enter
// after dictating or pasting a command into the TUI (dictation intentionally
// never auto-submits — the user reviews, then presses Enter). This row is
// that Enter, nothing more.
//
// WHY it is behind a setting although the row is tiny: same logic as
// ComposerActions. It costs a row of pane height in EVERY agent pane, and a
// keyboard user submits with Enter and gets nothing from it. Mouse mode makes
// the trade worth taking.
//
// WHY Submit is never disabled: the raw PTY's current line lives inside the
// provider's TUI, so there is nothing to read back and nothing to gate on.
// The button must be exactly as conservative as a hardware Enter key — always
// available. This is ComposerActions' "must not be more conservative than
// Enter" rule applied to a surface without a draft.
//
// WHY the row lives in AgentTerminalLeaf and is NOT shared with TerminalLeaf:
// ordinary shells are explicitly out of scope for this feature (issue #819).
// A plain shell pane never had a Send affordance to lose; mounting controls
// there would only add chrome to panes that must stay untouched.

export type AgentTerminalActionsProps = {
  /** Sends the Enter byte to the agent PTY. */
  onSubmit: () => void
}

export function AgentTerminalActions({ onSubmit }: AgentTerminalActionsProps): JSX.Element {
  return (
    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-surface px-3 py-1.5">
      <button
        type="button"
        // preventDefault keeps DOM focus out of this button: a focused button
        // would pull keystrokes away from xterm — the very thing this control
        // exists to complement. Deliberately NOT stopPropagation: the owning
        // leaf's own onMouseDown must still acknowledge and re-focus xterm.
        onMouseDown={event => event.preventDefault()}
        onClick={onSubmit}
        className="rounded-control border border-control-border bg-control-active-bg px-3 py-1 text-[11px] leading-none text-control-active-fg hover:bg-control-hover-bg"
      >
        Submit
      </button>
    </div>
  )
}