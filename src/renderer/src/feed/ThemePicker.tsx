import { useEffect, useRef, useState } from 'react'
import { applyTheme, THEMES, type ThemeId, type ThemeMeta } from '../themes'

// Theme picker — a single button in the header that opens a floating
// palette of themes. Each theme is a card with its swatch, name, blurb,
// and a preview of its display font.
//
// The trigger button doesn't show the current theme's name to keep the
// header tight — just a palette icon — because the name is the first
// thing you see in the menu. Current theme is highlighted there.
//
// Close behavior:
//   - click outside → close
//   - press Escape → close
//   - pick a theme → apply immediately + close after a tiny delay so the
//     user can see the selection land before the menu goes away

type Props = {
  current: ThemeId
  onChange: (id: ThemeId) => void
}

export function ThemePicker({ current, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Outside-click + Escape handling. One effect so cleanup is colocated.
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current) return
      if (!rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const pick = (id: ThemeId) => {
    applyTheme(id)
    onChange(id)
    // Small delay so the selection flash is visible before the menu closes.
    setTimeout(() => setOpen(false), 120)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        title="Change theme"
        aria-haspopup="menu"
        aria-expanded={open}
        className="
          flex items-center gap-1.5 px-2.5 py-1
          text-[11px] text-ink-dim
          rounded-md border border-border
          hover:border-border-hi hover:text-ink
          transition-colors duration-150
          [-webkit-app-region:no-drag]
        "
      >
        <PaletteIcon />
        <span className="font-medium">theme</span>
      </button>

      {open && (
        <div
          role="menu"
          className="
            modal-pop absolute right-0 top-full mt-2 z-50
            w-[320px] p-2
            bg-surface border border-border-hi rounded-xl
            shadow-[0_20px_60px_rgba(0,0,0,0.5),0_4px_12px_rgba(0,0,0,0.3)]
          "
        >
          <div className="px-3 pt-2 pb-1.5 text-[10px] uppercase tracking-wider text-muted font-medium">
            Theme
          </div>
          <ul className="flex flex-col gap-1">
            {THEMES.map(t => (
              <ThemeRow
                key={t.id}
                theme={t}
                active={t.id === current}
                onPick={pick}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function ThemeRow({
  theme,
  active,
  onPick,
}: {
  theme: ThemeMeta
  active: boolean
  onPick: (id: ThemeId) => void
}) {
  return (
    <li>
      <button
        type="button"
        role="menuitemradio"
        aria-checked={active}
        onClick={() => onPick(theme.id)}
        className={`
          w-full flex items-start gap-3 px-3 py-2.5 rounded-lg text-left
          transition-colors duration-150
          ${
            active
              ? 'bg-accent-soft text-ink'
              : 'hover:bg-surface-hi text-ink-dim hover:text-ink'
          }
        `}
      >
        {/* Three stacked swatch chips representing canvas / ink / accent */}
        <div className="flex-shrink-0 mt-0.5">
          <SwatchStack swatches={theme.swatches} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2">
            <span
              className="font-display text-[15px] font-semibold leading-none"
              style={{ fontFamily: `'${theme.displayFont}', serif` }}
            >
              {theme.name}
            </span>
            {active && (
              <span className="text-[9px] uppercase tracking-wider text-accent font-bold">
                active
              </span>
            )}
          </div>
          <div className="text-[11px] mt-1 leading-snug text-muted">
            {theme.blurb}
          </div>
        </div>
      </button>
    </li>
  )
}

function SwatchStack({ swatches }: { swatches: [string, string, string] }) {
  return (
    <div
      className="w-9 h-9 rounded-md border border-border-hi overflow-hidden grid grid-rows-3"
      aria-hidden="true"
    >
      {swatches.map((c, i) => (
        <div key={i} style={{ background: c }} />
      ))}
    </div>
  )
}

function PaletteIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 14c-3.3 0-6-2.7-6-6s2.7-6 6-6 6 2.3 6 5.2c0 1.8-1.5 2.3-2.8 2.3-.9 0-1.7.4-1.7 1.2 0 .8.7 1.5.7 2.1 0 .7-.6 1.2-2.2 1.2z" />
      <circle cx="5.5" cy="6.5" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="9" cy="4.5" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="11.5" cy="7.5" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  )
}
