type Props = {
  state: { workspace?: string } | null
  onSend: (data: string) => Promise<void>
}

export function CodexTrustDialogModal({ state, onSend }: Props) {
  if (!state) return null

  const accept = () => { void onSend('\r') }
  const decline = () => { void onSend('2\r') }

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
          w-[480px] max-w-[calc(100vw-64px)]
          bg-surface border border-border-hi
          p-6
        "
      >
        <div className="flex items-start gap-3 mb-4">
          <div className="text-accent text-[18px] leading-none select-none pt-0.5">!</div>
          <div className="text-[14px] font-semibold text-ink leading-[1.3]">
            Trust this directory?
          </div>
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
          <button
            type="button"
            onClick={decline}
            className="
              px-4 py-1.5 text-[12px]
              bg-transparent text-ink-dim
              border border-border
              hover:border-border-hi hover:text-ink
              transition-colors duration-120
            "
          >
            cancel
          </button>
          <button
            type="button"
            onClick={accept}
            autoFocus
            className="
              px-4 py-1.5 text-[12px] font-semibold
              bg-accent text-accent-fg
              border border-accent
              hover:brightness-110
              transition-all duration-120
            "
          >
            trust directory
          </button>
        </div>
      </div>
    </div>
  )
}
