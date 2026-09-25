import type { ConditionAction } from '@shared/conditions-core/contract'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { DialogActions } from '@renderer/components/ui/dialog-actions'
import { withVisibleControls } from '@shared/text/visibleControls'

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

  // The app's dialog grammar (UI pass), matching Claude's trust prompt.
  return (
    <Dialog open onOpenChange={nextOpen => {
      if (!nextOpen) decline()
    }}>
      <DialogContent
        className="modal-pop"
        onPointerDownOutside={event => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Trust this folder?</DialogTitle>
          <DialogDescription>Codex is about to work in this folder.</DialogDescription>
        </DialogHeader>
        <div className="px-4 py-3 text-[12px] leading-[1.6] text-ink-dim">
          {state.workspace && (
            <pre className="mb-2 overflow-x-auto whitespace-nowrap rounded-slab bg-code-bg px-3 py-2 font-code text-[12px] text-accent">
              {withVisibleControls(state.workspace)}
            </pre>
          )}
          <p className="text-[11px] text-muted">
            Continue only if you trust the contents of this folder.
          </p>
        </div>
        <DialogActions
          onCancel={decline}
          confirmLabel="Trust Folder"
          onConfirm={accept}
          initialFocus="confirm"
        />
      </DialogContent>
    </Dialog>
  )
}
