import type { ConditionAction } from '@shared/conditions-core/contract'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'

type Props = {
  state: { workspace?: string } | null
  /** The condition's own action list, straight off the wire snapshot. */
  actions: ConditionAction[]
  dispatch: (action: ConditionAction) => Promise<void>
}

export function CodexTrustDialogModal({ state, actions, dispatch }: Props) {
  if (!state) return null

  // The keystrokes are the PROVIDER's contract, and this component does not
  // get an opinion about them. It used to hardcode '\r' and '2\r' — both
  // wrong: '\r' confirms whatever Codex currently HIGHLIGHTS, so any stray
  // arrow key turned "trust directory" into "quit", and the trailing '\r' on
  // decline leaked an Enter into the next screen.
  //
  // The fix is not better constants here, it is not having constants here.
  // The snapshot already carries the provider's own actions with their bytes;
  // dispatching them by id keeps one source of truth in the parser and means a
  // future upstream key change is a provider-side edit only. It also keeps the
  // phone client's bundle free of the headless package — importing the
  // constants directly broke that build, which is what surfaced this.
  const byId = (id: string): ConditionAction | undefined =>
    actions.find(action => action.id === id)
  const run = (id: string) => {
    const action = byId(id)
    if (action) void dispatch(action)
  }
  const accept = () => run('accept')
  const decline = () => run('reject')

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
