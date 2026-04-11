import { useEffect, useState } from 'react'

import { PathInput } from '../components/PathInput'

// PathPickerModal — modal that asks the user for a working directory
// when they press ⌘T (or click the + button in the tab bar).
//
// Most of the complexity (completion dropdown, keyboard nav, tab
// complete) now lives in <PathInput> so this file stays tiny — just
// the modal chrome, the error slot, and the cancel/open buttons.
// PathInput owns typing, suggestions, and all keyboard handling;
// this component owns submit → validate → spawn.

type Props = {
  open: boolean
  defaultValue?: string
  onCancel: () => void
  onAccept: (expandedPath: string) => void | Promise<void>
}

export function PathPickerModal({
  open,
  defaultValue = '',
  onCancel,
  onAccept,
}: Props) {
  const [value, setValue] = useState(defaultValue)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Reset on open so a stale error / value from a previous attempt
  // doesn't carry over.
  useEffect(() => {
    if (!open) return
    setValue(defaultValue)
    setError(null)
    setBusy(false)
  }, [open, defaultValue])

  if (!open) return null

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    const result = await window.api.expandCwd(value)
    if (!result.ok) {
      setError(result.error)
      setBusy(false)
      return
    }
    await onAccept(result.path)
    setBusy(false)
  }

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
      onMouseDown={e => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        className="
          modal-pop
          w-[560px] max-w-[calc(100vw-64px)]
          bg-surface border border-border-hi
          p-6
        "
      >
        <div className="text-[13px] font-semibold text-ink mb-4">
          New tab — working directory
        </div>

        {/* PathInput is the reusable piece — input + completion dropdown
            + keyboard nav — so this file doesn't re-implement any of it. */}
        <div className="relative mb-2">
          <div className="absolute left-2 top-1/2 -translate-y-1/2 text-accent text-[12px] pointer-events-none select-none z-10">
            ❯
          </div>
          <PathInput
            value={value}
            onChange={next => {
              setValue(next)
              if (error) setError(null)
            }}
            onSubmit={() => void submit()}
            onCancel={onCancel}
            placeholder="/path/to/project or ~/…"
            directoriesOnly
            autoFocus
            disabled={busy}
            inputClassName={`
              w-full
              bg-canvas text-ink text-[12px]
              pl-6 pr-3 py-2.5
              border
              ${error ? 'border-danger' : 'border-border'}
              focus:border-accent
              outline-none
              transition-colors duration-120
            `}
          />
        </div>

        {/* Error slot — reserves space so the modal doesn't jump when
            an error appears/disappears. */}
        <div className="min-h-[16px] text-[11px] mb-4">
          {error ? (
            <span className="text-danger">{error}</span>
          ) : (
            <span className="text-muted">
              tab completes · ↑↓ to browse · enter to open · esc to cancel
            </span>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="
              px-4 py-1.5 text-[12px]
              bg-transparent text-ink-dim
              border border-border
              hover:border-border-hi hover:text-ink
              transition-colors duration-120
              disabled:opacity-50
            "
          >
            cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || value.trim() === ''}
            className="
              px-4 py-1.5 text-[12px] font-semibold
              bg-accent text-accent-fg
              border border-accent
              hover:brightness-110
              transition-all duration-120
              disabled:opacity-50
            "
          >
            open
          </button>
        </div>
      </div>
    </div>
  )
}
