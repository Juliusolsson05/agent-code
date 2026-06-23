import {
  ACCENTS,
  AGENT_VIEW_MODES,
  DEFAULT_SETTINGS,
  FONT_FAMILIES,
  THEME_MODES,
  WORKSPACE_MODES,
  type AccentId,
  type FontFamilyId,
  type Settings,
} from '@renderer/app-state/settings/types'
import { coerceCustomAppearanceJson } from '@renderer/app-state/settings/customAppearance'
import { coerceHotkeyBinding } from '@renderer/lib/hotkeyBinding'
import {
  APP_SETTINGS_STORAGE_KEY,
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
    customAppearanceJson: coerceCustomAppearanceJson(parsed.customAppearanceJson),
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
    // `!== false` so the default is ON — only an explicit persisted `false`
    // turns autosend off. Fresh installs / older workspace.json blobs (no
    // such key) get the on-by-default behavior.
    autoSendPromptSuggestion: parsed.autoSendPromptSuggestion !== false,
    // WHY membership check via WORKSPACE_MODES rather than a literal
    // === 'dispatch': keeps the source of truth in one array so adding
    // a new mode label later (if ever) only requires editing types.ts.
    defaultWorkspaceMode: WORKSPACE_MODES.some(m => m.id === parsed.defaultWorkspaceMode)
      ? (parsed.defaultWorkspaceMode as Settings['defaultWorkspaceMode'])
      : DEFAULT_SETTINGS.defaultWorkspaceMode,
    // Agent view mode is a product contract, not a loose string. A typo in
    // localStorage must fall back to the compatible custom-rendered Agent mode
    // rather than accidentally booting every pane into raw terminal mode.
    agentViewMode: AGENT_VIEW_MODES.some(m => m.id === parsed.agentViewMode)
      ? (parsed.agentViewMode as Settings['agentViewMode'])
      : DEFAULT_SETTINGS.agentViewMode,
    // Same membership-check pattern as accent/mode: garbage / typo / a
    // removed font id from a future migration falls back to the default
    // rather than crashing applyTheme with an undefined family string.
    fontFamily: FONT_FAMILIES.some(f => f.id === parsed.fontFamily)
      ? (parsed.fontFamily as FontFamilyId)
      : DEFAULT_SETTINGS.fontFamily,
    // Same defensive coercion philosophy as the membership checks above:
    // a corrupt or hand-edited localStorage blob must never reach the
    // command registry as anything but a clean `Record<string, boolean>`.
    // We rebuild the map entry-by-entry, dropping any non-boolean value
    // (and implicitly any non-string key — object keys are strings, but
    // arrays/null would have failed the plain-object guard first), so the
    // registry's `typeof override === 'boolean'` check can trust the
    // shape. A garbage value collapses to `{}` (nothing overridden),
    // matching the "absent ≡ declared default" semantic.
    commandVisibilityOverrides: coerceCommandVisibilityOverrides(
      parsed.commandVisibilityOverrides,
    ),
  }
}

function coerceCommandVisibilityOverrides(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, boolean> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'boolean') result[key] = entry
  }
  return result
}

export function loadInitialSettings(): Settings {
  try {
    const raw = localStorage.getItem(APP_SETTINGS_STORAGE_KEY)
    if (!raw) return DEFAULT_SETTINGS
    return coerceSettings(JSON.parse(raw))
  } catch {
    return DEFAULT_SETTINGS
  }
}
