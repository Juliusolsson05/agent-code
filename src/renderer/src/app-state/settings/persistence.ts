import {
  ACCENTS,
  AGENT_VIEW_MODES,
  DEFAULT_SETTINGS,
  FONT_FAMILIES,
  isBuiltInThemeMode,
  USAGE_HEADER_LEVELS,
  WORKSPACE_MODES,
} from '@renderer/app-state/settings/types'
import {
  V4_CUSTOM_MIGRATION_MARKER,
  coerceSavedThemes,
  createSavedTheme,
  findSavedTheme,
  isSavedThemeId,
  isV4MigratedTheme,
} from '@renderer/app-state/settings/savedThemes'
import type { SavedTheme } from '@renderer/app-state/settings/savedThemes'
import { parseCustomAppearanceJson } from '@renderer/app-state/settings/customAppearance'
import type {
  AccentId,
  FontFamilyId,
  Settings,
  UsageHeaderLevel,
} from '@renderer/app-state/settings/types'
import { coerceCustomAppearanceJson } from '@renderer/app-state/settings/customAppearance'
import { coerceDispatchColorFlags } from '@renderer/app-state/settings/dispatchColorFlags'
import { coerceHotkeyBinding } from '@renderer/lib/hotkeyBinding'
import { coerceSavedPromptTemplates } from '@renderer/features/prompt-templates/savedPromptTemplates'
import { normalizeConfigurableBuiltInMcpDomains } from '@mcp/shared/types'

export function coerceSettings(value: unknown): Settings {
  const parsed = value && typeof value === 'object'
    ? value as Partial<Settings>
    : {}

  // WHY savedThemes is computed here rather than inline in the returned
  // object: `mode` validity DEPENDS on which themes survived coercion — a mode
  // pointing at a theme just dropped for unparseable JSON has to fall back to
  // the default. Resolving both inline would read the raw, un-coerced array and
  // could leave mode pointing at a theme that no longer exists, which renders
  // as Dark with no inline properties and looks to the user like the setting
  // silently reset itself.
  const savedThemes = migrateLegacyCustomAppearance(parsed, coerceSavedThemes(parsed.savedThemes))
  const savedPromptTemplates = coerceSavedPromptTemplates(parsed.savedPromptTemplates)

  return {
    ...DEFAULT_SETTINGS,
    ...parsed,
    savedThemes,
    savedPromptTemplates,
    dispatchColorFlags: coerceDispatchColorFlags(parsed.dispatchColorFlags),
    mode: resolvePersistedMode(parsed, savedThemes),
    contrast: parsed.contrast === true,
    accent: ACCENTS.some(a => a.id === parsed.accent)
      ? (parsed.accent as AccentId)
      : DEFAULT_SETTINGS.accent,
    customAppearanceJson: coerceCustomAppearanceJson(parsed.customAppearanceJson),
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
    // `!== false` → on by default; only an explicit persisted `false`
    // disables the header widget (same pattern as showWorktreeBadges).
    usageHeaderEnabled: parsed.usageHeaderEnabled !== false,
    // Membership check, same philosophy as accent/fontFamily: a typo or
    // a level removed by a future release must fall back to 'all', not
    // crash the header or persist garbage forward.
    usageHeaderLevel: USAGE_HEADER_LEVELS.includes(
      parsed.usageHeaderLevel as UsageHeaderLevel,
    )
      ? (parsed.usageHeaderLevel as UsageHeaderLevel)
      : DEFAULT_SETTINGS.usageHeaderLevel,
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
    // WHY this is a closed configurable-domain normalizer instead of the
    // broader session normalizer: persisted Settings must never promote the
    // diagnostic `ping` domain into every future agent. Provider filtering is
    // intentionally later, when the concrete new session kind is known.
    defaultBuiltInMcpDomains: normalizeConfigurableBuiltInMcpDomains(
      parsed.defaultBuiltInMcpDomains,
    ),
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
    // Strict `=== true` so a fresh install, a malformed value, and any store
    // written before this field existed all resolve to OFF. Anything looser
    // (`!== false`) would flip the default on for every existing user, which
    // is the opposite of the intent: the group is hidden because six extra
    // rows help almost nobody, and silently revealing them on upgrade would
    // be a regression nobody asked for.
    navigationCommandsEnabled: parsed.navigationCommandsEnabled === true,
  }
}

// v4 and earlier had exactly one unnamed custom palette, selected by
// `mode === 'custom'`. Converting it into a real saved theme is what keeps an
// upgrading user looking at the same colors they had before the update.
//
// WHY this lives in coerceSettings instead of only in zustand's `migrate`:
// `migrate` fires only when the stored version is older, but same-version blobs
// can still be stale (interrupted writes, hand-edited localStorage, a dev build
// that ran this branch before the version bump landed). Coercion runs on every
// launch through `merge`, so putting the conversion here makes it unconditional.
// The migration marker is what makes re-running it idempotent.
function migrateLegacyCustomAppearance(
  parsed: Partial<Settings>,
  savedThemes: SavedTheme[],
): SavedTheme[] {
  if (parsed.mode !== 'custom') return savedThemes
  // WHY the guard keys on the marker and NOT on the theme's name: names are
  // deliberately non-unique AND user-editable. A name match lets this sequence
  // orphan real data — name a theme "Custom" on v5, run a v4 build (which
  // rewrites version: 4 but leaves savedThemes in the blob) and set
  // mode: 'custom', then upgrade: the migration sees the name, concludes it has
  // already run, and the customAppearanceJson the user was just looking at is
  // silently abandoned. A marker cannot be produced by renaming.
  if (savedThemes.some(isV4MigratedTheme)) return savedThemes
  const raw = typeof parsed.customAppearanceJson === 'string'
    ? parsed.customAppearanceJson
    : ''
  try {
    parseCustomAppearanceJson(raw, 'lenient')
  } catch {
    // Matches the pre-existing coerceCustomAppearanceJson policy: an
    // unparseable payload degrades silently rather than blocking boot. The
    // user lands on Dark, which is what they would have seen anyway.
    return savedThemes
  }
  return [
    createSavedTheme(LEGACY_CUSTOM_THEME_NAME, raw, V4_CUSTOM_MIGRATION_MARKER),
    ...savedThemes,
  ]
}

const LEGACY_CUSTOM_THEME_NAME = 'Custom'

// Accepts a built-in id, or a saved theme id that actually resolves against the
// already-coerced list. Anything else — a typo, a theme deleted on another
// machine, the legacy 'custom' sentinel whose migration just produced a real
// theme — falls back rather than leaving mode pointing at nothing.
function resolvePersistedMode(
  parsed: Partial<Settings>,
  savedThemes: SavedTheme[],
): Settings['mode'] {
  if (parsed.mode === 'custom') {
    // Same marker, same reason as the guard above — resolving the legacy mode
    // by name would hand the user whichever theme they happened to call
    // "Custom" rather than the one their old payload became.
    const migrated = savedThemes.find(isV4MigratedTheme)
    return migrated ? migrated.id : DEFAULT_SETTINGS.mode
  }
  if (isBuiltInThemeMode(parsed.mode)) return parsed.mode
  if (isSavedThemeId(parsed.mode) && findSavedTheme(savedThemes, parsed.mode)) {
    return parsed.mode
  }
  return DEFAULT_SETTINGS.mode
}

function coerceCommandVisibilityOverrides(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, boolean> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'boolean') result[key] = entry
  }
  return result
}
