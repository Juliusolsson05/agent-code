import { ACCENTS, DEFAULT_SETTINGS, THEME_MODES, type AccentId, type Settings } from '@renderer/app-state/settings/types'

const LEGACY_STORAGE_KEY = 'cc-shell:settings'

export function loadInitialSettings(): Settings {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw) as Partial<Settings>
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      mode: THEME_MODES.some(option => option.id === parsed.mode)
        ? (parsed.mode as Settings['mode'])
        : DEFAULT_SETTINGS.mode,
      contrast: parsed.contrast === true,
      accent: ACCENTS.some(a => a.id === parsed.accent)
        ? (parsed.accent as AccentId)
        : DEFAULT_SETTINGS.accent,
      customRendering: parsed.customRendering === true,
      showWorktreeBadges: parsed.showWorktreeBadges !== false,
      dangerousAgentsEnabled: parsed.dangerousAgentsEnabled === true,
      useProxyStreaming: parsed.useProxyStreaming === true,
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}
