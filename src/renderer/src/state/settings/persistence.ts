import { ACCENTS, DEFAULT_SETTINGS, type AccentId, type Settings } from './types'

const LEGACY_STORAGE_KEY = 'cc-shell:settings'

export function loadInitialSettings(): Settings {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    const parsed = JSON.parse(raw) as Partial<Settings>
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      mode: parsed.mode === 'light' ? 'light' : 'dark',
      accent: ACCENTS.some(a => a.id === parsed.accent)
        ? (parsed.accent as AccentId)
        : DEFAULT_SETTINGS.accent,
      customRendering: parsed.customRendering === true,
      dangerousAgentsEnabled: parsed.dangerousAgentsEnabled === true,
    }
  } catch {
    return DEFAULT_SETTINGS
  }
}
