import { detectTrustDialog } from '../../../core/parsers/trustDialog'

// Trust-dialog overlay. See the comment in the previous pre-Tailwind
// version for the full design rationale. Short version: the React
// modal surfaces CC's "Accessing workspace" prompt as a real widget so
// the user isn't stuck staring at raw terminal text, and the Accept /
// Decline buttons synthesize the same keystrokes CC already listens
// for (\r / \x1b). Detection is delegated to core/parsers/trustDialog
// so the testbench's auto-accept mode and this modal share one source
// of truth.

type Props = {
  screen: string
  onSend: (data: string) => void
}

export function TrustDialogModal({ screen, onSend }: Props) {
  const state = detectTrustDialog(screen)
  if (!state.visible) return null

  const accept = () => onSend('\r')
  const decline = () => onSend('\x1b')

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="
        modal-fade
        fixed inset-0 z-[1000]
        flex items-center justify-center
        bg-canvas/75 backdrop-blur-md
      "
    >
      <div
        className="
          modal-pop
          w-[460px] max-w-[calc(100vw-64px)]
          bg-surface border border-border-hi rounded-xl
          p-7 pb-5
          shadow-[0_24px_60px_rgba(0,0,0,0.6),0_2px_8px_rgba(0,0,0,0.4)]
        "
      >
        <div className="flex items-center gap-3 mb-4">
          <WarnIcon />
          <div className="font-display text-[18px] font-semibold tracking-tight text-ink leading-none">
            Trust this folder?
          </div>
        </div>

        <div className="text-[13.5px] leading-[1.6] text-ink-dim">
          <p className="mb-3">Claude Code is about to access:</p>
          {state.workspace && (
            <pre
              className="
                font-code text-[12.5px]
                bg-code-bg border border-code-border
                rounded-md px-3 py-2.5 mb-3
                text-accent
                overflow-x-auto whitespace-nowrap
              "
            >
              {state.workspace}
            </pre>
          )}
          <p className="text-[12.5px] text-muted">
            Claude Code will be able to{' '}
            <strong className="text-ink font-semibold">
              read, edit, and execute files
            </strong>{' '}
            in this folder. Only continue if this is a project you created or
            one you trust.
          </p>
        </div>

        <div className="flex justify-end gap-2.5 mt-6">
          <button
            type="button"
            onClick={decline}
            className="
              px-4 py-2 rounded-lg text-[13px] font-medium
              bg-transparent text-ink-dim
              border border-border
              hover:border-border-hi hover:text-ink
              transition-colors duration-150
              active:translate-y-px
            "
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={accept}
            autoFocus
            className="
              px-4 py-2 rounded-lg text-[13px] font-semibold
              bg-accent text-accent-fg
              border border-accent
              hover:brightness-110
              transition-all duration-150
              active:translate-y-px
              shadow-[0_1px_0_rgba(255,255,255,0.1)_inset]
            "
          >
            Yes, I trust this folder
          </button>
        </div>
      </div>
    </div>
  )
}

function WarnIcon() {
  // Theme-aware warning glyph. Uses the accent color so it picks up the
  // right mood per theme (lime in Noir, oxblood in Paper, green in
  // Phosphor, ember in Ember).
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-accent flex-shrink-0"
      aria-hidden="true"
    >
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}
