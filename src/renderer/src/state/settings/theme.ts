import { ACCENTS, isDarkThemeMode, type Settings } from '@renderer/state/settings/types'

export function applyTheme(settings: Settings): void {
  const root = document.documentElement
  root.dataset.mode = settings.mode
  root.dataset.contrast = settings.contrast ? 'high' : 'normal'
  const accent = ACCENTS.find(a => a.id === settings.accent) ?? ACCENTS[0]
  const hex = isDarkThemeMode(settings.mode) ? accent.dark : accent.light
  const fg = isDarkThemeMode(settings.mode) ? accent.fgDark : accent.fgLight
  root.style.setProperty('--theme-accent', hex)
  root.style.setProperty('--theme-accent-fg', fg)
  window.dispatchEvent(new CustomEvent('cc-shell:theme-changed', { detail: settings }))
}
