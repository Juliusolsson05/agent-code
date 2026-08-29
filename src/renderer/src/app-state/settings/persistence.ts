import {
  ACCENTS,
  AGENT_VIEW_MODES,
  CORNER_STYLES,
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
import { isCommandSortMode } from '@renderer/features/command-palette/lib/sortCommands'
import type { CommandSortMode } from '@renderer/features/command-palette/lib/sortCommands'
import type {
  AccentId,
  FontFamilyId,
  Settings,
  UsageHeaderLevel,
} from '@renderer/app-state/settings/types'
import { coerceCustomAppearanceJson } from '@renderer/app-state/settings/customAppearance'
import { coerceDispatchColorFlags } from '@renderer/app-state/settings/dispatchColorFlags'
import { coerceCommandKeybindingOverrides } from '@renderer/features/command-keybindings/resolve'
import { coerceHotkeyBinding } from '@renderer/lib/hotkeyBinding'
import { coerceMouseButtonBinding, coerceMouseChordBinding } from '@renderer/lib/mouseBinding'
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
    // WHY `parsed` is spread through a filter rather than directly: deleting a
    // field from the `Settings` TYPE does not delete it from a user's stored
    // blob. `...parsed` copies every key it finds, so a retired key survives
    // coercion, gets written back on the next save, and lives forever in
    // localStorage — invisible to TypeScript and impossible to reason about.
    // The plan calls this out explicitly for dispatchProjectTerminal.
    ...omitRetiredSettingsKeys(parsed),
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
    // WHY a closed-enum coercion here where dictationShortcut gets an open
    // one: keyboard bindings are arbitrary captured physical keys, but the
    // bindable mouse buttons are a fixed three. A persisted value outside
    // that set must fall back to off rather than arm a listener that
    // preventDefaults a button we have no contract for.
    dictationMouseButton: coerceMouseButtonBinding(parsed.dictationMouseButton),
    // Closed enum, same reasoning as the button binding above: an unknown
    // chord would arm a listener that suppresses buttons we have no contract
    // for, so anything outside the set falls back to off.
    paletteMouseChord: coerceMouseChordBinding(parsed.paletteMouseChord),
    aggressiveDebugPersistence: parsed.aggressiveDebugPersistence === true,
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
    // Corner style must be coerced for a sharper reason than most enums here:
    // applyTheme looks the tier up by id and writes its three lengths onto
    // <html>. An id that resolves to nothing would write `undefined` into
    // three custom properties, and every rounded-chip/slab/float utility in
    // the app would resolve to an invalid value at once. The fallback keeps a
    // blob from a newer build, or a hand-edited one, merely wrong rather than
    // globally unstyled.
    cornerStyle: CORNER_STYLES.some(c => c.id === parsed.cornerStyle)
      ? (parsed.cornerStyle as Settings['cornerStyle'])
      : DEFAULT_SETTINGS.cornerStyle,
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
    commandStarred: coerceCommandStarred(parsed.commandStarred),
    commandSortMode: coerceCommandSortMode(parsed.commandSortMode),
    // Strict opt-in: older stores have no key, and malformed persisted values
    // must not silently expand the command search surface.
    promptTemplatesInCommandSearchEnabled:
      parsed.promptTemplatesInCommandSearchEnabled === true,
    mouseModeEnabled: parsed.mouseModeEnabled === true,
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
    commandKeybindingOverrides: pruneRetiredKeybindingOverrides(
      coerceCommandKeybindingOverrides(parsed.commandKeybindingOverrides),
    ),
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

/**
 * First-party command ids this release deliberately removed.
 *
 * Their persisted preference entries are pruned so a stale visibility override
 * or keybinding cannot linger forever against an id nothing will ever resolve.
 *
 * WHY an explicit list instead of "delete any id not in the catalog": an id
 * that names nothing TODAY is not necessarily dead. It may belong to an
 * extension that is temporarily uninstalled, a provider whose commands this
 * build does not generate, or a command a downgrade removed. Pruning by
 * absence would silently discard a user's deliberate settings the first time
 * they ran an older build or disabled an extension. Only ids we KNOW are gone
 * for good are removed, and adding one is a deliberate act recorded here.
 *
 * Retired in the command-governance change: five durable preferences that had
 * both a command and a Settings control. The Settings controls (and their
 * canonical fields) are untouched, so no value migration is needed — only the
 * now-meaningless per-command preference entries go.
 */
const RETIRED_BUILT_IN_COMMAND_IDS: ReadonlySet<string> = new Set([
  'toggle-status-mode',
  'toggle-worktree-badges',
  'usage.toggle-header',
  'usage.cycle-header-level',
  'dangerous-agents',
])

/**
 * Persisted Settings keys this release removed.
 *
 * Listing them is what makes a removal real. A key absent from the type but
 * present in storage is worse than one that is merely unused: it round-trips
 * through every save, so the blob keeps growing and a future field with the
 * same name would silently inherit a stale value.
 *
 * Removed in the command-governance change: `dispatchProjectTerminal`, the
 * opt-in auto-created Dispatch project terminal. The whole feature is gone —
 * the Settings row, the auto-create effect, the dedicated side column and the
 * ensureDispatchTerminal action — so the preference has nothing left to
 * control.
 */
const RETIRED_SETTINGS_KEYS: readonly string[] = ['dispatchProjectTerminal']

function omitRetiredSettingsKeys(parsed: Partial<Settings>): Partial<Settings> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (RETIRED_SETTINGS_KEYS.includes(key)) continue
    result[key] = value
  }
  return result as Partial<Settings>
}

/**
 * Starred commands. Same shape and same retired-id hazard as
 * `coerceCommandVisibilityOverrides` below, with one deliberate difference: a
 * persisted `false` is DROPPED rather than stored. For stars the default is
 * always false, so `false` carries no information — keeping it would let the
 * map grow without bound while meaning nothing, and it would break the
 * absent-means-default invariant the visibility map documents.
 */
function coerceCommandStarred(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, boolean> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (RETIRED_BUILT_IN_COMMAND_IDS.has(key)) continue
    if (entry === true) result[key] = true
  }
  return result
}

/**
 * Fall back to the shipped default on anything unrecognized.
 *
 * The union is closed, but the blob it is read from is not: a settings file
 * written by a future build (a fifth mode), hand-edited in devtools, or
 * truncated mid-write can all put a string here that no longer means anything.
 * An unknown value must degrade to 'catalog' — the behavior the palette had
 * before this setting existed. Letting one through would NOT be harmless: it
 * falls past the 'catalog' and 'alpha' branches in `orderFlat` and lands on the
 * history sort, so an unrecognized mode would silently render as "recently
 * used" while the control displayed whatever string it read.
 */
function coerceCommandSortMode(value: unknown): CommandSortMode {
  return isCommandSortMode(value) ? value : DEFAULT_SETTINGS.commandSortMode
}

function coerceCommandVisibilityOverrides(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, boolean> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (RETIRED_BUILT_IN_COMMAND_IDS.has(key)) continue
    if (typeof entry === 'boolean') result[key] = entry
  }
  return result
}

/** Same retired-id policy, applied to persisted keybinding overrides. */
function pruneRetiredKeybindingOverrides(
  overrides: Record<string, string[]>,
): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  for (const [commandId, bindings] of Object.entries(overrides)) {
    if (RETIRED_BUILT_IN_COMMAND_IDS.has(commandId)) continue
    result[commandId] = bindings
  }
  return result
}
