import {
  CODEX_TRUST_DIALOG_ACCEPT_KEYS,
  CODEX_TRUST_DIALOG_DECLINE_KEYS,
} from 'codex-headless'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'

type Props = {
  state: { workspace?: string } | null
  onSend: (data: string) => Promise<void>
}

export function CodexTrustDialogModal({ state, onSend }: Props) {
  if (!state) return null

  // Keystrokes are the provider's contract, not this component's opinion.
  // They were '\r' and '2\r'; both were wrong. '\r' confirms whatever Codex
  // currently HIGHLIGHTS, so any stray arrow key turned "trust directory" into
  // "quit", and the trailing '\r' on decline leaked an Enter into the next
  // screen. Verified against a live codex-cli 0.145.0 dialog.
  const accept = () => { void onSend(CODEX_TRUST_DIALOG_ACCEPT_KEYS) }
  const decline = () => { void onSend(CODEX_TRUST_DIALOG_DECLINE_KEYS) }

  return (
    <Dialog open onOpenChange={nextOpen => {
      if (!nextOpen) decline()
    }}>
      <DialogContent
        className="modal-pop w-[480px] max-w-[calc(100vw-64px)] p-6"
        onPointerDownOutside={event => event.preventDefault()}
      >
        <div className="flex items-start gap-3 mb-4">
          <div className="text-accent text-[18px] leading-none select-none pt-0.5">!</div>
          <DialogTitle className="text-[14px] font-semibold leading-[1.3]">
            Trust this directory?
          </DialogTitle>
          <DialogDescription className="sr-only">
            Confirm whether Codex may work in the selected directory.
          </DialogDescription>
        </div>

        <div className="text-[12px] leading-[1.65] text-ink-dim pl-6">
          <p className="mb-3">Codex is about to work in:</p>
          {state.workspace && (
            <pre className="bg-code-bg text-accent px-3 py-2 mb-3 overflow-x-auto whitespace-nowrap text-[11.5px]">
              {state.workspace}
            </pre>
          )}
          <p className="text-[11.5px] text-muted">
            Continue only if you trust the contents of this directory.
          </p>
        </div>

        <div className="flex justify-end gap-2 mt-6 pl-6">
          <Button
            type="button"
            onClick={decline}
            variant="outline"
          >
            cancel
          </Button>
          <Button
            type="button"
            onClick={accept}
            autoFocus
          >
            trust directory
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
