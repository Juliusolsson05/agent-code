import { useEffect } from 'react'

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
  useEffect(() => {
    if (!state) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        void onSend('\r')
      } else if (event.key === 'Escape') {
        event.preventDefault()
        void onSend('3\r')
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [onSend, state])

  if (!state) return null

  const approve = () => { void onSend('\r') }
  const deny = () => { void onSend('3\r') }
  const title = state.title ?? 'Claude is requesting permission'

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="
        modal-fade
        fixed inset-0 z-[1000]
        flex items-center justify-center
        bg-canvas/80 backdrop-blur-sm
      "
    >
      <div
        className="
          modal-pop
          w-[520px] max-w-[calc(100vw-64px)]
          bg-surface border border-border-hi
          p-6
        "
      >
        <div className="flex items-start gap-3 mb-4">
          <div className="text-accent text-[18px] leading-none select-none pt-0.5">!</div>
          <div>
            <div className="text-[14px] font-semibold text-ink leading-[1.3]">
              {title}
            </div>
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
          <button
            type="button"
            onClick={deny}
            className="
              px-4 py-1.5 text-[12px]
              bg-transparent text-ink-dim
              border border-border
              hover:border-border-hi hover:text-ink
              transition-colors duration-120
            "
          >
            deny
          </button>
          <button
            type="button"
            onClick={approve}
            autoFocus
            className="
              px-4 py-1.5 text-[12px] font-semibold
              bg-accent text-accent-fg
              border border-accent
              hover:brightness-110
              transition-all duration-120
            "
          >
            approve
          </button>
        </div>
      </div>
    </div>
  )
}
