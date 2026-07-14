import { useEffect, useRef, useState } from 'react'

type Props = {
  open: boolean
  title: string
  description: string
  onCancel: () => void
  onConfirm: (note: string) => void
}

export function BuryPanePrompt({
  open,
  title,
  description,
  onCancel,
  onConfirm,
}: Props) {
  const [note, setNote] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!open) return
    setNote('')
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/30"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="w-[min(520px,92vw)] bg-surface border border-border-hi">
        <div className="border-b border-border px-4 py-3">
          <div className="text-[13px] text-ink">Bury Pane</div>
          <div className="text-[11px] text-muted mt-1">{title}</div>
          <div className="text-[10px] text-muted mt-0.5 truncate">{description}</div>
        </div>

        <div className="px-4 py-4">
          <label className="block text-[11px] text-muted mb-2">
            Optional note
          </label>
          <textarea
            ref={inputRef}
            rows={3}
            value={note}
            onChange={e => setNote(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.preventDefault()
                onCancel()
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                onConfirm(note)
              }
            }}
            className="
              w-full bg-canvas border border-border
              text-ink text-[12px] font-code
              px-3 py-2 outline-none
              placeholder:text-muted resize-none
            "
            placeholder="Why did you bury this pane?"
          />
        </div>

        <div className="border-t border-border px-4 py-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-[12px] border border-border text-ink-dim hover:text-ink hover:border-border-hi"
          >
            Cancel
          </button>
          {/* One confirm button. An empty textarea is the "skip the
              note" path — the store trims whitespace to undefined
              anyway. A separate "Skip Note" button that forced ''
              used to exist but did exactly the same thing as Bury
              with an empty field; users were just guessing which
              one to press. */}
          <button
            type="button"
            onClick={() => onConfirm(note)}
            className="px-3 py-1.5 text-[12px] border border-accent bg-accent text-accent-fg hover:brightness-110"
          >
            Bury
          </button>
        </div>
      </div>
    </div>
  )
}
