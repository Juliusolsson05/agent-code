import { useCallback, useEffect, useRef, useState } from 'react'

import {
  bindingFromKeyboardEvent,
  cloneEmptyModifiers,
  DEFAULT_DICTATION_HOTKEY,
  formatBindingForDisplay,
  isModifierKey,
  modifierOnlyBinding,
  updateHeldModifier,
  type HeldModifiers,
} from '@renderer/lib/hotkeyBinding'

type Props = {
  value: string
  onChange: (next: string) => void | Promise<void>
}

export function HotkeyInput({ value, onChange }: Props) {
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const heldModifiersRef = useRef<HeldModifiers>(cloneEmptyModifiers())
  const modifierCommitTimerRef = useRef<number | null>(null)

  const clearModifierCommitTimer = useCallback(() => {
    if (modifierCommitTimerRef.current === null) return
    window.clearTimeout(modifierCommitTimerRef.current)
    modifierCommitTimerRef.current = null
  }, [])

  const stop = useCallback(() => {
    heldModifiersRef.current = cloneEmptyModifiers()
    clearModifierCommitTimer()
    setCapturing(false)
  }, [clearModifierCommitTimer])

  useEffect(() => {
    if (!capturing) return

    const onKey = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopPropagation()

      updateHeldModifier(event, heldModifiersRef.current, true)

      if (event.key === 'Escape') {
        setError(null)
        stop()
        return
      }

      if (isModifierKey(event)) {
        const modifierOnly = modifierOnlyBinding(heldModifiersRef.current)
        clearModifierCommitTimer()
        if (modifierOnly) {
          // Modifier-only bindings need a short settle window so Cmd+K can
          // become Cmd+K instead of immediately saving bare Cmd. This mirrors
          // the standalone dictation app's capture behavior.
          modifierCommitTimerRef.current = window.setTimeout(() => {
            void Promise.resolve(onChange(modifierOnly)).then(stop)
          }, 450)
        }
        return
      }

      clearModifierCommitTimer()
      const { binding, error: nextError } = bindingFromKeyboardEvent(
        event,
        heldModifiersRef.current,
      )
      setError(nextError)
      if (!binding) return
      void Promise.resolve(onChange(binding)).then(stop)
    }

    const onKeyUp = (event: KeyboardEvent) => {
      updateHeldModifier(event, heldModifiersRef.current, false)
      if (!modifierOnlyBinding(heldModifiersRef.current)) clearModifierCommitTimer()
    }

    const onBlur = () => {
      heldModifiersRef.current = cloneEmptyModifiers()
      clearModifierCommitTimer()
    }

    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('blur', onBlur)
      heldModifiersRef.current = cloneEmptyModifiers()
      clearModifierCommitTimer()
    }
  }, [capturing, clearModifierCommitTimer, onChange, stop])

  useEffect(() => {
    if (!capturing) return
    const onClick = (event: MouseEvent) => {
      if (!containerRef.current) return
      if (!containerRef.current.contains(event.target as Node)) stop()
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [capturing, stop])

  return (
    <div ref={containerRef} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <button
          type="button"
          aria-pressed={capturing}
          onClick={() => {
            setError(null)
            heldModifiersRef.current = cloneEmptyModifiers()
            if (capturing) stop()
            else setCapturing(true)
          }}
          className={`
            min-w-0 flex-1 border px-3 py-2 text-left font-code text-[12px]
            ${capturing
              ? 'border-accent bg-accent/10 text-accent'
              : 'border-border text-ink-dim hover:border-border-hi hover:text-ink'}
          `}
        >
          {capturing
            ? 'Press any key or shortcut'
            : formatBindingForDisplay(value) || 'Click to set binding'}
        </button>
        <button
          type="button"
          onClick={() => void onChange(DEFAULT_DICTATION_HOTKEY)}
          className="border border-border px-3 py-2 text-[12px] text-ink-dim hover:border-border-hi hover:text-ink"
        >
          Default
        </button>
      </div>

      {!capturing ? (
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => void onChange('Fn')}
            className="border border-border px-2 py-1 text-[11px] text-muted hover:border-border-hi hover:text-ink"
          >
            fn
          </button>
          <button
            type="button"
            onClick={() => void onChange('Cmd')}
            className="border border-border px-2 py-1 text-[11px] text-muted hover:border-border-hi hover:text-ink"
          >
            Cmd
          </button>
        </div>
      ) : null}

      {error ? <div className="text-[11px] text-muted">{error}</div> : null}
    </div>
  )
}
