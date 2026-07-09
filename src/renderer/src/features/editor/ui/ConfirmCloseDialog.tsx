type Props = {
  fileName: string
  onSaveAndClose: () => void
  onDiscard: () => void
  onCancel: () => void
}

// Unsaved-changes gate for tab close.
//
// WHY this is rendered by EditorWorkbench as an absolutely-positioned
// scrim over the editor area rather than a portal/global modal: the
// decision belongs to exactly one workbench (Global Editor left pane or
// the AI Workspace variant living in the same slot), and a global modal
// would have to fight the command palette / settings overlays for
// z-index and focus ownership. Scoping it to the workbench also means a
// second editor surface gets the dialog for free without any modal
// registry.
export function ConfirmCloseDialog({
  fileName,
  onSaveAndClose,
  onDiscard,
  onCancel,
}: Props) {
  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/40">
      <div className="w-[360px] rounded border border-border bg-surface p-4 font-code text-[12px] text-ink shadow-lg">
        <div className="mb-1 font-semibold">Unsaved changes</div>
        <div className="mb-4 text-ink-dim">
          “{fileName}” has unsaved changes. Save before closing?
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-border px-3 py-1 text-ink-dim hover:bg-surface-hi hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onDiscard}
            className="rounded border border-border px-3 py-1 text-danger hover:bg-surface-hi"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={onSaveAndClose}
            autoFocus
            className="rounded bg-accent px-3 py-1 text-black hover:opacity-90"
          >
            Save &amp; Close
          </button>
        </div>
      </div>
    </div>
  )
}
