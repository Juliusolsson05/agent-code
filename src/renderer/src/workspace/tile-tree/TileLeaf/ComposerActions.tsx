import { Button } from '@renderer/components/ui/button'
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
  /** True while the agent is producing output — gates Stop's visibility.
   *  Deliberately no `exited` prop: see the WHY on `sendDisabled`. */
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
  working,
  dictationStatus,
  onSend,
  onStop,
}: ComposerActionsProps) {
  // Mirrors the phone's predicate (remote-client SessionView) plus the two
  // desktop-only blockers below. Kept as one expression rather than early
  // returns so the disabled reasons stay readable together.
  // WHY there is no `exited` term here, despite the phone's Send having one:
  // an exited pane is NOT a dead end on the desktop. TileLeaf's `send()` routes
  // failed/exited panes through `ensureSessionLive` on purpose — "provider
  // attempts are disposable... main's stable-id recovery protocol is explicitly
  // retryable" — so pressing Enter in an exited pane wakes it and delivers.
  // Copying the phone's `transcript.exited` term verbatim disabled this button
  // in exactly the state where the app has a deliberate recovery path, leaving
  // a Mouse Mode user staring at a permanently dimmed control with no
  // explanation. The button must not be more conservative than Enter.
  const sendDisabled =
    (input.trim().length === 0 && !hasDraftImages) ||
    sending ||
    deliveryUncertain ||
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
        <Button
          variant="outline"
          size="sm"
          // preventDefault on mousedown keeps focus in the textarea. Without
          // it, clicking moves DOM focus to this button, which drops the
          // composer's focus ring and makes the bare-Enter router bail
          // (composerEnterRegistry treats a focused interactive element as
          // "not the composer").
          onMouseDown={event => event.preventDefault()}
          onClick={onStop}
          // Deliberately NOT `destructive-outline`, which colours its text
          // danger at rest. Stop sits permanently beside Send while an agent
          // runs; a permanently red control there reads as an error state
          // rather than an available action. Danger belongs on hover only —
          // the one case in this PR where the shared variant is the wrong fit.
          className="hover:border-danger hover:bg-transparent hover:text-danger"
        >
          Stop
        </Button>
      ) : null}
      <button
        type="button"
        disabled={sendDisabled}
        onMouseDown={event => event.preventDefault()}
        onClick={onSend}
        className="rounded-control border border-control-border bg-control-active-bg px-3 py-1 text-[11px] leading-none text-control-active-fg hover:bg-control-hover-bg disabled:opacity-40 disabled:hover:bg-control-active-bg"
      >
        {sending ? '…' : 'Send'}
      </button>
    </div>
  )
}
