import { detectTrustDialog } from '../../../core/parsers/trustDialog'

// The trust dialog is CC's first-run modal: when the user points CC at a
// directory it doesn't recognize, CC refuses to take any action until the
// user either confirms trust or bails. Out of the box in cc-shell this
// would leave the user staring at raw terminal text asking them to press
// Enter — which is exactly the kind of "goofy terminal inlining" we're
// trying to hide. So: detect it from the screen buffer, render a real
// React modal, synthesize keystrokes for Accept / Decline.
//
// Detection shares the `detectTrustDialog` parser with the testbench's
// auto-accept mode, so any fix to the detector improves both paths.
//
// Why this component owns the detection instead of App.tsx:
//   Keeping the detection next to the rendering means App.tsx doesn't
//   have to know the trust-dialog state exists at all. If the parser
//   says "visible: false", this component renders nothing. The absence
//   of the modal is represented by returning null, not by a parent
//   state flag — simpler ownership, no stale-state bugs.

type Props = {
  /**
   * Current PTY screen buffer text. The component reruns detection on
   * every screen update (cheap — string search for a few markers) and
   * decides to render based on the parser's output.
   */
  screen: string
  /**
   * Called with a keystroke sequence to send to the PTY. Hooked up to
   * `window.api.sendInput` in the parent.
   */
  onSend: (data: string) => void
}

export function TrustDialogModal({ screen, onSend }: Props) {
  const state = detectTrustDialog(screen)
  if (!state.visible) return null

  // CC pre-selects "Yes, I trust this folder", so Enter accepts.
  // Esc cancels. These match CC's own keybindings — we're not inventing
  // a new protocol, just surfacing the same keys CC already listens for.
  const accept = () => onSend('\r')
  const decline = () => onSend('\x1b') // ESC

  return (
    <div className="trust-modal-backdrop" role="dialog" aria-modal="true">
      <div className="trust-modal">
        <div className="trust-modal-header">
          <div className="trust-modal-icon">⚠</div>
          <div className="trust-modal-title">Trust this folder?</div>
        </div>

        <div className="trust-modal-body">
          <p>
            Claude Code is about to access:
          </p>
          {state.workspace && (
            <pre className="trust-modal-path">{state.workspace}</pre>
          )}
          <p className="trust-modal-warning">
            Claude Code will be able to <strong>read, edit, and execute
            files</strong> in this folder. Only continue if this is a project
            you created or one you trust.
          </p>
        </div>

        <div className="trust-modal-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={decline}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={accept}
            autoFocus
          >
            Yes, I trust this folder
          </button>
        </div>
      </div>
    </div>
  )
}
