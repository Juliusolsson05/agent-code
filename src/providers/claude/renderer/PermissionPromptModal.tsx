import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { DialogActions } from '@renderer/components/ui/dialog-actions'
import { withVisibleControls } from '@shared/text/visibleControls'

type PermissionPromptState = {
  title?: string
  toolName?: string
  command?: string
  options?: Array<{ key: string; label: string }>
  selectedIndex?: number
}

type Props = {
  state: PermissionPromptState | null
  onSend: (data: string) => Promise<void>
}

export function PermissionPromptModal({ state, onSend }: Props) {
  if (!state) return null

  const approve = () => { void onSend('\r') }
  const deny = () => { void onSend('3\r') }
  const title = state.title ?? 'Claude is requesting permission'

  // The app's dialog grammar (UI pass), like TrustDialogModal: header, px-4
  // body, shared footer with Title Case labels ("deny" / "approve" were
  // lowercase) and key chips. Approve keeps initial focus, as before.
  return (
    <Dialog
      open
      onOpenChange={nextOpen => {
        if (!nextOpen) deny()
      }}
    >
      <DialogContent
        className="modal-pop"
        onPointerDownOutside={event => {
          // A permission decision must be explicit. Escape is a documented
          // deny shortcut, but an accidental backdrop click must not send a
          // destructive PTY choice on the user's behalf.
          event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle>{withVisibleControls(title)}</DialogTitle>
          <DialogDescription>
            {state.toolName ? `Tool: ${state.toolName}` : 'Review the request and choose whether Claude may continue.'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 px-4 py-3 text-[12px] leading-[1.6] text-ink-dim">
          {state.command && (
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-slab bg-code-bg px-3 py-2 font-code text-[12px] text-accent">
              {withVisibleControls(state.command)}
            </pre>
          )}
          {state.options && state.options.length > 0 && (
            <ol className="flex flex-col gap-1 text-[11px] text-muted">
              {state.options.map((option, index) => (
                <li
                  key={`${option.key}:${option.label}`}
                  className={index === state.selectedIndex ? 'text-ink' : undefined}
                >
                  {option.key}. {withVisibleControls(option.label)}
                </li>
              ))}
            </ol>
          )}
        </div>
        <DialogActions
          onCancel={deny}
          cancelLabel="Deny"
          confirmLabel="Approve"
          onConfirm={approve}
          initialFocus="confirm"
        />
      </DialogContent>
    </Dialog>
  )
}
