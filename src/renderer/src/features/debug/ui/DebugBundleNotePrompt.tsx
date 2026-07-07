import { useEffect, useRef, useState } from 'react'

type Props = {
  open: boolean
  title: string
  description: string
  bundlePath: string
  onCancel: () => void
  onConfirm: (note: string) => void
  // Optional label overrides so this same modal can back BOTH the debug-bundle
  // note and the Attach-Recording-Note flow (plan §7b) instead of forking a
  // second near-identical component. Defaults preserve the original
  // debug-bundle wording, so existing callers are unaffected. The footer path
  // line is only rendered when `bundlePath` is non-empty — a recording note
  // has no path to show.
  heading?: string
  placeholder?: string
  fieldLabel?: string
}

export function DebugBundleNotePrompt({
  open,
  title,
  description,
  bundlePath,
  onCancel,
  onConfirm,
  heading = 'Add Debug Bundle Note',
  placeholder = 'Why did you save this debug bundle?',
  fieldLabel = 'Optional note',
}: Props) {
  const [note, setNote] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!open) return
    setNote('')
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [open, bundlePath])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[1100] flex items-center justify-center bg-black/30"
      onMouseDown={e => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="w-[min(560px,92vw)] bg-surface border border-border-hi">
        <div className="border-b border-border px-4 py-3">
          <div className="text-[13px] text-ink">{heading}</div>
          <div className="text-[11px] text-muted mt-1">{title}</div>
          <div className="text-[10px] text-muted mt-0.5 truncate">{description}</div>
        </div>

        <div className="px-4 py-4">
          <label className="block text-[11px] text-muted mb-2">
            {fieldLabel}
          </label>
          <textarea
            ref={inputRef}
            rows={4}
            value={note}
            onChange={e => setNote(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Escape') {
                e.preventDefault()
                onCancel()
                return
              }
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
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
            placeholder={placeholder}
          />
          {bundlePath ? (
            <div className="mt-2 truncate text-[10px] text-muted" title={bundlePath}>
              {bundlePath}
            </div>
          ) : null}
        </div>

        <div className="border-t border-border px-4 py-3 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1.5 text-[12px] border border-border text-ink-dim hover:text-ink hover:border-border-hi"
          >
            Skip
          </button>
          <button
            type="button"
            onClick={() => onConfirm(note)}
            className="px-3 py-1.5 text-[12px] border border-accent bg-accent text-accent-fg hover:brightness-110"
          >
            Save Note
          </button>
        </div>
      </div>
    </div>
  )
}
