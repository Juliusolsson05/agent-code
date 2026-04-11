import { useEffect, useRef, useState } from 'react'
import {
  ACCENTS,
  applyTheme,
  saveSettings,
  type AccentId,
  type Settings,
  type ThemeMode,
} from '../themes'

// Settings menu — a small button in the header that opens a floating
// panel with: mode toggle (dark/light), accent color swatches, and a
// couple of visibility toggles.
//
// Kept flat and fast: one dropdown, everything visible, no nested
// accordions. The settings surface is intentionally small.

type Props = {
  settings: Settings
  onChange: (next: Settings) => void
}

export function ThemePicker({ settings, onChange }: Props) {
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

  const update = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch }
    applyTheme(next)
    saveSettings(next)
    onChange(next)
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        title="Settings"
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
        <SettingsIcon />
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
            <div className="flex">
              <ModeButton
                mode="dark"
                current={settings.mode}
                onPick={m => update({ mode: m })}
              />
              <ModeButton
                mode="light"
                current={settings.mode}
                onPick={m => update({ mode: m })}
              />
            </div>
          </Section>

          <Section title="accent">
            <div className="grid grid-cols-4 gap-1.5">
              {ACCENTS.map(a => (
                <AccentSwatch
                  key={a.id}
                  id={a.id}
                  color={settings.mode === 'dark' ? a.dark : a.light}
                  name={a.name}
                  active={settings.accent === a.id}
                  onPick={id => update({ accent: id })}
                />
              ))}
            </div>
          </Section>

          <Section title="view">
            <Toggle
              label="High contrast"
              value={settings.highContrast}
              onChange={v => update({ highContrast: v })}
            />
            <Toggle
              label="Live terminal preview"
              value={settings.showTerminalPreview}
              onChange={v => update({ showTerminalPreview: v })}
            />
            <Toggle
              label="System events"
              value={settings.showSystemEvents}
              onChange={v => update({ showSystemEvents: v })}
            />
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
  current,
  onPick,
}: {
  mode: ThemeMode
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
      {mode}
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

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className="
        w-full flex items-center justify-between
        py-1.5 px-0
        text-[11px] text-ink-dim hover:text-ink
        transition-colors duration-120
      "
    >
      <span>{label}</span>
      <span
        className={`
          w-3.5 h-3.5 border
          transition-colors duration-120
          ${value ? 'bg-accent border-accent' : 'bg-transparent border-border-hi'}
        `}
      >
        {value && (
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-accent-fg">
            <path d="M3 7.5l2.5 2.5L11 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </span>
    </button>
  )
}

function SettingsIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="2" />
      <path d="M12.5 8a4.5 4.5 0 0 0-.07-.8l1.4-1.1-1.4-2.4-1.7.6a4.5 4.5 0 0 0-1.4-.8L9 1.5h-2L6.7 3.5a4.5 4.5 0 0 0-1.4.8l-1.7-.6-1.4 2.4 1.4 1.1a4.5 4.5 0 0 0 0 1.6l-1.4 1.1 1.4 2.4 1.7-.6a4.5 4.5 0 0 0 1.4.8l.3 2h2l.3-2a4.5 4.5 0 0 0 1.4-.8l1.7.6 1.4-2.4-1.4-1.1c.05-.26.07-.53.07-.8z" />
    </svg>
  )
}
