import { useCallback, useEffect, useRef, useState } from 'react'

import {
  formatMouseButtonForDisplay,
  mouseButtonBindingFromButton,
} from '@renderer/lib/mouseBinding'
import type { MouseButtonBinding } from '@renderer/lib/mouseBinding'

type Props = {
  value: MouseButtonBinding
  onChange: (next: MouseButtonBinding) => void | Promise<void>
}

/**
 * Capture control for the dictation mouse button.
 *
 * WHY capture instead of a three-item dropdown: which physical thumb button
 * reports DOM button 3 versus 4 varies by mouse and driver, so "Back" and
 * "Forward" are not names a user can map to their own hardware by reading
 * them. Pressing the button you intend to use is the only unambiguous input.
 *
 * WHY this does not reuse `HotkeyInput`: that component captures modifier-only
 * holds with a settle timer and speaks the keyboard binding grammar — none of
 * which applies here. `CommandKeybindingsRow.tsx` already documents the same
 * non-reuse decision for the same reason.
 *
 * WHY capturing here cannot accidentally start dictation: `SettingsPage`
 * marks itself as the app interaction owner, and `beginDictationHold()`
 * refuses to start while an owner is mounted. Note this gates the START only
 * — `useDictationMouseTrigger`'s listeners stay installed and still swallow
 * the bound button everywhere in Settings, including its text areas. So
 * middle-click paste really is dead here if Middle is bound; that is the
 * documented cost of binding a button, not a bug in this control.
 */
export function MouseButtonInput({ value, onChange }: Props) {
  const [capturing, setCapturing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const stop = useCallback(() => setCapturing(false), [])

  useEffect(() => {
    if (!capturing) return

    const onPointerDown = (event: PointerEvent) => {
      const binding = mouseButtonBindingFromButton(event.button)

      if (!binding) {
        // Left/right. A click outside the control is the standard cancel
        // gesture (same as HotkeyInput); inside, it is a user trying to bind
        // a button we refuse, and they deserve to be told why rather than
        // watching nothing happen.
        const inside = containerRef.current?.contains(event.target as Node) ?? false
        if (!inside) {
          setError(null)
          stop()
          return
        }
        // ...unless they clicked this control's OWN buttons. Those are the
        // toggle and Off affordances, not an attempt to bind left click, and
        // window-capture pointerdown runs before their click handlers. Without
        // this branch, pressing "Off" flashed the reserved-button warning and
        // left the control still armed — value cleared, label still reading
        // "Press the mouse button you want", and the next middle-click
        // anywhere in the app silently re-bound it.
        if ((event.target as HTMLElement | null)?.closest('button')) return
        setError('Left and right click stay reserved. Use the middle or a side button.')
        return
      }

      // Reserve the press so capturing a side button does not also navigate
      // history or paste into whatever is behind the settings surface.
      event.preventDefault()
      event.stopPropagation()
      setError(null)
      void Promise.resolve(onChange(binding)).then(stop)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      setError(null)
      stop()
    }

    // Swallow the click that follows a captured aux press, otherwise the
    // browser still acts on it after we have committed the binding.
    const onAuxClick = (event: MouseEvent) => {
      if (!mouseButtonBindingFromButton(event.button)) return
      event.preventDefault()
      event.stopPropagation()
    }

    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('auxclick', onAuxClick, true)
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('auxclick', onAuxClick, true)
      window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [capturing, onChange, stop])

  return (
    <div ref={containerRef} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <button
          type="button"
          aria-pressed={capturing}
          onClick={() => {
            setError(null)
            if (capturing) stop()
            else setCapturing(true)
          }}
          className={`
            min-w-0 flex-1 border px-3 py-2 text-left font-code text-[12px]
            ${capturing
              ? 'border-input-border-focus bg-row-selected-bg text-accent'
              : 'border-control-border bg-control-bg text-control-fg hover:border-control-border-hover hover:bg-control-hover-bg hover:text-ink'}
          `}
        >
          {capturing
            ? 'Press the mouse button you want'
            : formatMouseButtonForDisplay(value) || 'Click to set a button'}
        </button>
        <button
          type="button"
          onClick={() => {
            setError(null)
            // Leave capture mode too. "Off" must mean off — staying armed
            // after clearing the value is the contradiction described above.
            stop()
            void onChange('')
          }}
          className="border border-control-border bg-control-bg px-3 py-2 text-[12px] text-control-fg hover:border-control-border-hover hover:bg-control-hover-bg hover:text-ink"
        >
          Off
        </button>
      </div>

      {error ? <div className="text-[11px] text-muted">{error}</div> : null}
    </div>
  )
}
