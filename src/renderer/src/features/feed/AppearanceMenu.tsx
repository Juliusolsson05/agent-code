import { useEffect, useRef, useState } from 'react'

import {
  ACCENTS,
  type AccentId,
  type Settings,
  THEME_MODES,
  isDarkThemeMode,
  type ThemeMode,
} from '../../state/settings/types'

type Props = {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
}

export function AppearanceMenu({ settings, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

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

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        title="Appearance"
        aria-haspopup="menu"
        aria-expanded={open}
        className="
          flex items-center justify-center
          w-7 h-7
          text-ink-dim hover:text-ink
          border border-border hover:border-border-hi
          transition-colors duration-150
          [-webkit-app-region:no-drag]
        "
      >
        <EyeIcon />
      </button>

      {open && (
        <div
          role="menu"
          className="
            modal-pop absolute right-0 top-full mt-2 z-50
            w-[280px]
            bg-surface border border-border-hi
            shadow-[0_16px_48px_rgba(0,0,0,0.4)]
          "
          >
          <Section title="mode">
            <div className="grid grid-cols-2 gap-1.5">
              {THEME_MODES.map(mode => (
                <ModeButton
                  key={mode.id}
                  mode={mode.id}
                  label={mode.label}
                  current={settings.mode}
                  onPick={nextMode => onChange({ mode: nextMode })}
                />
              ))}
            </div>
          </Section>

          <Section title="accent">
            <div className="grid grid-cols-4 gap-1.5">
              {ACCENTS.map(a => (
                <AccentSwatch
                  key={a.id}
                  id={a.id}
                  color={isDarkThemeMode(settings.mode) ? a.dark : a.light}
                  name={a.name}
                  active={settings.accent === a.id}
                  onPick={accent => onChange({ accent })}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={() => onChange({ contrast: !settings.contrast })}
              className="mt-3 flex w-full items-center justify-between border border-border px-2.5 py-2 text-left text-[11px] text-ink-dim hover:border-border-hi hover:text-ink"
            >
              <span>High Contrast</span>
              <span
                className={`
                  flex h-3.5 w-3.5 border
                  ${settings.contrast ? 'bg-accent border-accent' : 'bg-transparent border-border-hi'}
                `}
              />
            </button>
          </Section>
        </div>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="px-3 pt-3 pb-3 border-b border-border last:border-b-0">
      <div className="text-[9px] uppercase tracking-[0.18em] text-muted font-medium mb-2">
        {title}
      </div>
      {children}
    </div>
  )
}

function ModeButton({
  mode,
  label,
  current,
  onPick,
}: {
  mode: ThemeMode
  label: string
  current: ThemeMode
  onPick: (m: ThemeMode) => void
}) {
  const active = mode === current
  return (
    <button
      type="button"
      onClick={() => onPick(mode)}
      className={`
        flex-1 px-3 py-1.5 text-[11px] uppercase tracking-wider
        border border-border
        transition-colors duration-120
        ${
          active
            ? 'bg-accent text-accent-fg border-accent font-semibold'
            : 'text-ink-dim hover:text-ink hover:border-border-hi'
        }
      `}
    >
      {label}
    </button>
  )
}

function AccentSwatch({
  id,
  color,
  name,
  active,
  onPick,
}: {
  id: AccentId
  color: string
  name: string
  active: boolean
  onPick: (id: AccentId) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(id)}
      title={name}
      aria-label={name}
      aria-pressed={active}
      className={`
        aspect-square
        transition-all duration-120
        ${active ? 'ring-2 ring-ink ring-offset-2 ring-offset-surface' : 'hover:brightness-110'}
      `}
      style={{ background: color }}
    />
  )
}

function EyeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <path d="M1.5 8s2.3-4 6.5-4 6.5 4 6.5 4-2.3 4-6.5 4-6.5-4-6.5-4z" />
      <circle cx="8" cy="8" r="2.2" />
    </svg>
  )
}
