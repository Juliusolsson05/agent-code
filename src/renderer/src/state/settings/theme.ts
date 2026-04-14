import { ACCENTS, type Settings } from './types'

export function applyTheme(settings: Settings): void {
  const root = document.documentElement
  root.dataset.mode = settings.mode
  const accent = ACCENTS.find(a => a.id === settings.accent) ?? ACCENTS[0]
  const hex = settings.mode === 'dark' ? accent.dark : accent.light
  const fg = settings.mode === 'dark' ? accent.fgDark : accent.fgLight
  root.style.setProperty('--theme-accent', hex)
  root.style.setProperty('--theme-accent-fg', fg)
  window.dispatchEvent(new CustomEvent('cc-shell:theme-changed', { detail: settings }))
}
