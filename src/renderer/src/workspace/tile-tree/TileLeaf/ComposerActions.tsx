import type { DictationStatus } from '@shared/types/dictation'

// ComposerActions — pointer-clickable Send and Stop, shown only in Mouse Mode.
//
// WHY this is a sibling row in TileLeaf rather than markup inside
// ComposerInput: ComposerInput is SHARED with the remote phone client, which
// renders it inside its own composer and already draws its own Send button
// underneath. Adding buttons inside the shared component would double them on
// the phone. The phone's layout — a `.composer-actions` row below the input —
// is the shape being mirrored here deliberately, so the two surfaces stay
// recognisably the same product.
//
// WHY it is behind a setting when nothing else in this work is: it costs a row
// of height in EVERY agent pane, permanently, and a user who submits with
// Enter gets nothing for it. Steppers and the Dispatch "+" cost nothing when
// unused; this does.
//
// WHY Stop lives here too: interrupting a running agent was Escape / Ctrl+C /
// Ctrl+D only, with no affordance anywhere in the pane. A user driving agents
// with one hand on the mouse could start a turn and then have no way to stop
// it — the worst gap the mouse audit found, and worse than the missing Send,
// because the failure mode is an agent you cannot call off.

export type ComposerActionsProps = {
  /** Draft text, used only for the empty check. */
  input: string
  hasDraftImages: boolean
  /** True while a prompt is in flight (runtime.promptDelivery.kind === 'sending'). */
  sending: boolean
  /** True when delivery is in the unresolved state that blocks submit. */
  deliveryUncertain: boolean
  /** True while the provider is being switched — submit is hard-blocked. */
  providerSwitching: boolean
  /** True while the composer is in slash-command mode. */
  slashMode: boolean
  /** True when the session has exited. */
  exited: boolean
  /** True while the agent is producing output — gates Stop's visibility. */
  working: boolean
  dictationStatus: DictationStatus
  onSend: () => void
  onStop: () => void
}

export function ComposerActions({
  input,
  hasDraftImages,
  sending,
  deliveryUncertain,
  providerSwitching,
  slashMode,
  exited,
  working,
  dictationStatus,
  onSend,
  onStop,
}: ComposerActionsProps) {
  // Mirrors the phone's predicate (remote-client SessionView) plus the two
  // desktop-only blockers below. Kept as one expression rather than early
  // returns so the disabled reasons stay readable together.
  const sendDisabled =
    (input.trim().length === 0 && !hasDraftImages) ||
    sending ||
    deliveryUncertain ||
    exited ||
    // Provider switch already disables the textarea; the button must agree or
    // it would look like the one live control on a dead composer.
    providerSwitching ||
    // SLASH MODE IS LOAD-BEARING. `submitCurrentDraft` does NOT guard it —
    // only the Enter registry does. A Send button that ignored slash mode
    // would run the normal submit path against text the PTY already owns,
    // double-delivering it.
    slashMode ||
    // Mid-dictation the draft is a provisional transcript preview, not
    // user-owned text. Sending it would commit words the user has not
    // finished saying.
    dictationStatus === 'recording' ||
    dictationStatus === 'starting'

  return (
    <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-surface px-3 py-1.5">
      {working ? (
        <button
          type="button"
          // preventDefault on mousedown keeps focus in the textarea. Without
          // it, clicking moves DOM focus to this button, which drops the
          // composer's focus ring and makes the bare-Enter router bail
          // (composerEnterRegistry treats a focused interactive element as
          // "not the composer").
          onMouseDown={event => event.preventDefault()}
          onClick={onStop}
          className="border border-control-border bg-control-bg px-3 py-1 text-[11px] leading-none text-control-fg hover:border-danger hover:text-danger"
        >
          Stop
        </button>
      ) : null}
      <button
        type="button"
        disabled={sendDisabled}
        onMouseDown={event => event.preventDefault()}
        onClick={onSend}
        className="border border-control-border bg-control-active-bg px-3 py-1 text-[11px] leading-none text-control-active-fg hover:bg-control-hover-bg disabled:opacity-40 disabled:hover:bg-control-active-bg"
      >
        {sending ? '…' : 'Send'}
      </button>
    </div>
  )
}
