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

export function TrustDialogModal({ state, onSend }: Props) {
  if (!state) return null

  const accept = () => { void onSend('\r') }
  const decline = () => { void onSend('\x1b') }

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
            Trust this folder?
          </DialogTitle>
          <DialogDescription className="sr-only">
            Confirm whether Claude Code may access the selected folder.
          </DialogDescription>
        </div>

        <div className="text-[12px] leading-[1.65] text-ink-dim pl-6">
          <p className="mb-3">Claude Code is about to access:</p>
          {state.workspace && (
            <pre className="bg-code-bg text-accent px-3 py-2 mb-3 overflow-x-auto whitespace-nowrap text-[11.5px]">
              {state.workspace}
            </pre>
          )}
          <p className="text-[11.5px] text-muted">
            Claude Code will be able to{' '}
            <strong className="text-ink font-semibold">
              read, edit, and execute files
            </strong>{' '}
            in this folder. Only continue if this is a project you created or
            one you trust.
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
            trust this folder
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
