import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@renderer/components/ui/dialog'

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

  return (
    <Dialog
      open
      onOpenChange={nextOpen => {
        if (!nextOpen) deny()
      }}
    >
      <DialogContent
        className="modal-pop w-[520px] max-w-[calc(100vw-64px)] p-6"
        onPointerDownOutside={event => {
          // A permission decision must be explicit. Escape is a documented
          // deny shortcut, but an accidental backdrop click must not send a
          // destructive PTY choice on the user's behalf.
          event.preventDefault()
        }}
      >
        <div className="flex items-start gap-3 mb-4">
          <div className="text-accent text-[18px] leading-none select-none pt-0.5">!</div>
          <div>
            <DialogTitle className="text-[14px] font-semibold leading-[1.3]">
              {title}
            </DialogTitle>
            <DialogDescription className="sr-only">
              Review the requested tool and choose whether Claude may continue.
            </DialogDescription>
            {state.toolName && (
              <div className="mt-1 text-[11px] uppercase tracking-[0.14em] text-muted">
                {state.toolName}
              </div>
            )}
          </div>
        </div>

        <div className="text-[12px] leading-[1.65] text-ink-dim pl-6">
          {state.command && (
            <pre className="bg-code-bg text-accent px-3 py-2 mb-3 overflow-x-auto whitespace-pre-wrap text-[11.5px]">
              {state.command}
            </pre>
          )}
          {state.options && state.options.length > 0 && (
            <div className="space-y-1 text-[11.5px] text-muted">
              {state.options.map((option, index) => (
                <div
                  key={`${option.key}:${option.label}`}
                  className={index === state.selectedIndex ? 'text-ink' : undefined}
                >
                  {option.key}. {option.label}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 mt-6 pl-6">
          <Button
            type="button"
            onClick={deny}
            variant="outline"
          >
            deny
          </Button>
          <Button
            type="button"
            onClick={approve}
            autoFocus
          >
            approve
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
