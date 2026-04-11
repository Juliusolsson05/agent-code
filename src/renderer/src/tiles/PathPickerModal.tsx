import { useEffect, useRef, useState } from 'react'

// PathPickerModal — modal that asks the user for a working directory
// when they press ⌘T (or click the + button in the tab bar).
//
// Explicitly a TEXT INPUT, not a native folder picker. Keyboard-first,
// supports `~` and `~/…` expansion (done in main), and keeps the modal
// open with an inline error if the path is invalid so the user can fix
// the typo without losing what they've already typed.

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
  const inputRef = useRef<HTMLInputElement>(null)

  // Reset state every time the modal opens so a stale error from a
  // previous attempt doesn't carry over, and so the default value
  // reflects the current most-recent session cwd.
  useEffect(() => {
    if (!open) return
    setValue(defaultValue)
    setError(null)
    setBusy(false)
    // Defer focus until after the element is in the DOM.
    setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 0)
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
      inputRef.current?.focus()
      return
    }
    await onAccept(result.path)
    setBusy(false)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    // Stop propagation so global keybinds (⌘T, ⌘W, etc.) don't fire
    // while the user is typing in the modal.
    e.stopPropagation()
    if (e.key === 'Enter') {
      e.preventDefault()
      void submit()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
      return
    }
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

        <div className="relative mb-2">
          <div className="absolute left-2 top-1/2 -translate-y-1/2 text-accent text-[12px] pointer-events-none select-none">
            ❯
          </div>
          <input
            ref={inputRef}
            className={`
              w-full
              bg-canvas text-ink text-[12px]
              pl-6 pr-3 py-2.5
              border
              ${error ? 'border-danger' : 'border-border'}
              focus:border-accent
              outline-none
              transition-colors duration-120
            `}
            value={value}
            onChange={e => {
              setValue(e.target.value)
              if (error) setError(null)
            }}
            onKeyDown={onKeyDown}
            placeholder="/path/to/project or ~/…"
            spellCheck={false}
            autoComplete="off"
            disabled={busy}
          />
        </div>

        {/* Error slot — reserves space so the modal doesn't jump when
            an error appears/disappears. */}
        <div className="min-h-[16px] text-[11px] mb-4">
          {error ? (
            <span className="text-danger">{error}</span>
          ) : (
            <span className="text-muted">
              enter to open · esc to cancel · ~ is expanded
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
