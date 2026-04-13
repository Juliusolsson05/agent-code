type Props = {
  open: boolean
  onClose: () => void
}

export function SettingsPage({ open, onClose }: Props) {
  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-canvas/80 backdrop-blur-sm"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="w-[720px] max-w-[calc(100vw-64px)] max-h-[80vh] flex flex-col bg-surface border border-border-hi">
        <div className="flex items-center justify-between border-b border-border px-5 py-3 flex-shrink-0">
          <div>
            <div className="text-[14px] font-semibold text-ink">Settings</div>
            <div className="text-[11px] text-muted">
              Settings are being moved into a dedicated surface.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-[12px] border border-border text-ink-dim hover:text-ink hover:border-border-hi"
          >
            Close
          </button>
        </div>

        <div className="p-5 overflow-auto">
          <div className="border border-border bg-canvas px-4 py-4">
            <div className="text-[12px] text-ink mb-2">Structure in progress</div>
            <div className="text-[11px] text-muted leading-5">
              Command registration is now being separated from UI, and settings are
              getting their own feature area. The existing quick theme controls in the
              header still remain the active settings surface during this migration.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
