import { ACCENTS, isDarkThemeMode, type Settings } from '@renderer/app-state/settings/types'
import { APP_SLUG } from '@shared/appIdentity'

export function applyTheme(settings: Settings): void {
  const root = document.documentElement
  root.dataset.mode = settings.mode
  root.dataset.contrast = settings.contrast ? 'high' : 'normal'
  const accent = ACCENTS.find(a => a.id === settings.accent) ?? ACCENTS[0]
  const hex = isDarkThemeMode(settings.mode) ? accent.dark : accent.light
  const fg = isDarkThemeMode(settings.mode) ? accent.fgDark : accent.fgLight
  root.style.setProperty('--theme-accent', hex)
  root.style.setProperty('--theme-accent-fg', fg)
  window.dispatchEvent(new CustomEvent(`${APP_SLUG}:theme-changed`, { detail: settings }))
}
