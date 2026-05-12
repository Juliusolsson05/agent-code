import {
  ACCENTS,
  DEFAULT_SETTINGS,
  THEME_MODES,
  WORKSPACE_MODES,
  type AccentId,
  type Settings,
} from '@renderer/app-state/settings/types'
import { coerceHotkeyBinding } from '@renderer/lib/hotkeyBinding'
import {
  APP_SETTINGS_STORAGE_KEY,
  LEGACY_SETTINGS_STORAGE_KEY,
} from '@renderer/app-state/localStorageMigration'

export function coerceSettings(value: unknown): Settings {
  const parsed = value && typeof value === 'object'
    ? value as Partial<Settings>
    : {}

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
    showStatusMode: parsed.showStatusMode !== false,
    showWorktreeBadges: parsed.showWorktreeBadges !== false,
    dangerousAgentsEnabled: parsed.dangerousAgentsEnabled === true,
    useProxyStreaming: parsed.useProxyStreaming === true,
    dictationEnabled: parsed.dictationEnabled === true,
    dictationProvider: parsed.dictationProvider === 'deepgram'
      ? parsed.dictationProvider
      : DEFAULT_SETTINGS.dictationProvider,
    // WHY not validate against a fixed enum: dictation hotkeys are user-captured
    // physical bindings, not a closed product list. We only normalize legacy
    // fixed-choice values from the first integration draft and fall back for
    // non-strings so a corrupt localStorage blob cannot break settings boot.
    dictationShortcut: coerceHotkeyBinding(parsed.dictationShortcut),
    aggressiveDebugPersistence: parsed.aggressiveDebugPersistence === true,
    // Strict `=== true` so missing OR malformed values default to off —
    // matches the "off by default, opt in" semantics promised in the
    // setting's docstring. Anything looser (e.g. `!== false`) would
    // flip the default to ON for fresh installs.
    dispatchProjectTerminal: parsed.dispatchProjectTerminal === true,
    // WHY membership check via WORKSPACE_MODES rather than a literal
    // === 'dispatch': keeps the source of truth in one array so adding
    // a new mode label later (if ever) only requires editing types.ts.
    defaultWorkspaceMode: WORKSPACE_MODES.some(m => m.id === parsed.defaultWorkspaceMode)
      ? (parsed.defaultWorkspaceMode as Settings['defaultWorkspaceMode'])
      : DEFAULT_SETTINGS.defaultWorkspaceMode,
  }
}

export function loadInitialSettings(): Settings {
  try {
    const raw =
      localStorage.getItem(APP_SETTINGS_STORAGE_KEY) ??
      localStorage.getItem(LEGACY_SETTINGS_STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    return coerceSettings(JSON.parse(raw))
  } catch {
    return DEFAULT_SETTINGS
  }
}
