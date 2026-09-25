import {
  ACCENTS,
  AGENT_VIEW_MODES,
  CORNER_STYLES,
  DEFAULT_SETTINGS,
  FONT_FAMILIES,
  isBuiltInThemeMode,
  SHIPPED_BUILT_IN_MCP_DOMAINS,
  USAGE_HEADER_LEVELS,
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
import { isExtensionThemeMode } from '@shared/types/extensionThemes'
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
import { coerceBuiltInMcpDefaults, uniformBuiltInMcpDefaults } from '@mcp/shared/types'

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
  // Must run before mode/accent are resolved below — see migrateLegacyDefaultAppearance.
  const legacyAppearance = migrateLegacyDefaultAppearance(parsed)

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
    mode: legacyAppearance?.mode ?? resolvePersistedMode(parsed, savedThemes),
    contrast: parsed.contrast === true,
    agentNamesEnabled: parsed.agentNamesEnabled === true,
    // A retired accent id ('lime', 'sage') fails the membership test and lands
    // on Frost — that is the intended landing for the green accents (#973).
    accent: legacyAppearance?.accent
      ?? (ACCENTS.some(a => a.id === parsed.accent)
        ? (parsed.accent as AccentId)
        : DEFAULT_SETTINGS.accent),
    customAppearanceJson: coerceCustomAppearanceJson(parsed.customAppearanceJson),
    showStatusMode: parsed.showStatusMode !== false,
    // On by default (#1172) and for EXISTING installs too: `!== false` so a
    // blob written before this key existed reads as on, and only an explicit
    // persisted `false` (the user turned it off) stays off.
    showAgentCompletionIndicator: parsed.showAgentCompletionIndicator !== false,
    showWorktreeBadges: parsed.showWorktreeBadges !== false,
    // `!== false`: absent → on (the #973 default); only an explicit persisted
    // `false` keeps dangerous mode off. Same idiom as useProxyStreaming.
    dangerousAgentsEnabled: parsed.dangerousAgentsEnabled !== false,
    // `!== false` and not `=== true`, and this line is load-bearing: the
    // DEFAULT_SETTINGS spread above already seeds `true`, but an `=== true`
    // coercion overwrites it with `false` for every blob that has no such
    // key — i.e. every existing install and every fresh one whose settings
    // were written before the flip. The default would have been silently
    // undone at read time and nobody would see live model output. Same
    // idiom as showStatusMode / autoSendPromptSuggestion below: absent key
    // → on, explicit persisted `false` → off, which is exactly the promise
    // that flipping the default must not break for users who turned proxy
    // streaming off on purpose.
    useProxyStreaming: parsed.useProxyStreaming !== false,
    // Same absent-key → on idiom: the gh credential upgrade must reach every
    // existing install, while an explicit persisted `false` (the privacy
    // opt-out in Settings → Extensions) stays honored.
    extensionsGithubCliAuth: parsed.extensionsGithubCliAuth !== false,
    dictationEnabled: parsed.dictationEnabled === true,
    // Keep disconnected devices: hydration cannot inventory hardware, and
    // forgetting the choice here would silently switch a docked user's mic.
    dictationAudioInput:
      parsed.dictationAudioInput
      && typeof parsed.dictationAudioInput.deviceId === 'string'
      && parsed.dictationAudioInput.deviceId.trim().length > 0
        ? {
            deviceId: parsed.dictationAudioInput.deviceId,
            label: typeof parsed.dictationAudioInput.label === 'string'
              ? parsed.dictationAudioInput.label
              : '',
          }
        : null,
    dictationProvider: parsed.dictationProvider === 'deepgram'
      ? parsed.dictationProvider
      : DEFAULT_SETTINGS.dictationProvider,
    // WHY not validate against a fixed enum: dictation hotkeys are user-captured
    // physical bindings, not a closed product list. We only normalize legacy
    // fixed-choice values from the first integration draft and fall back for
    // non-strings so a corrupt localStorage blob cannot break settings boot.
    dictationShortcut: coerceHotkeyBinding(parsed.dictationShortcut),
    // Absent → the shipped binding; present → the closed-enum coercion. The
    // split matters because '' is a VALID persisted value meaning "off", and
    // an install that turned the button off must not get it back on upgrade.
    dictationMouseButton: parsed.dictationMouseButton === undefined
      ? DEFAULT_SETTINGS.dictationMouseButton
      : coerceMouseButtonBinding(parsed.dictationMouseButton),
    // Closed enum, same reasoning as the button binding above: an unknown
    // chord would arm a listener that suppresses buttons we have no contract
    // for, so anything outside the set falls back to off. Absent → the
    // shipped 'Middle+Right' (#973); '' stays a real "off" choice.
    paletteMouseChord: parsed.paletteMouseChord === undefined
      ? DEFAULT_SETTINGS.paletteMouseChord
      : coerceMouseChordBinding(parsed.paletteMouseChord),
    aggressiveDebugPersistence: parsed.aggressiveDebugPersistence === true,
    // Strict `=== true` for the two risky switches so a malformed or hand-edited
    // settings file can never turn them on; `!== false` for the harmless one.
    // Already-enabled installs have made their MCP choices. Migration must
    // not silently re-grant a domain the user removed from a provider.
    browserPocketDefaultsInitialized: parsed.browserPocketDefaultsInitialized === true || parsed.browserPocketEnabled === true,
    browserPocketEnabled: parsed.browserPocketEnabled === true,
    browserPocketOpenLocalhostLinks: parsed.browserPocketOpenLocalhostLinks !== false,
    browserPocketAllowEvaluate: parsed.browserPocketAllowEvaluate === true,
    // `=== true`: absent → off (the #973 default); an explicit `true` from an
    // older blob keeps autosend on for the user who had it.
    autoSendPromptSuggestion: parsed.autoSendPromptSuggestion === true,
    // `=== true`: absent → off (the #973 default) — the header quota widget
    // is opt-in for the public build, same explicit-choice rule as autosend.
    usageHeaderEnabled: parsed.usageHeaderEnabled === true,
    // Membership check, same philosophy as accent/fontFamily: a typo or
    // a level removed by a future release must fall back to 'all', not
    // crash the header or persist garbage forward.
    usageHeaderLevel: USAGE_HEADER_LEVELS.includes(
      parsed.usageHeaderLevel as UsageHeaderLevel,
    )
      ? (parsed.usageHeaderLevel as UsageHeaderLevel)
      : DEFAULT_SETTINGS.usageHeaderLevel,
    // `defaultWorkspaceMode` is dropped on read (#992): a stale persisted
    // value names a mode that no longer exists and selects nothing.
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
    //
    // Absent → the shipped domain set; present (even `[]`) → normalized as
    // before. An explicit empty list is a real choice ("no MCP by default"),
    // which is why the absent branch cannot go through the normalizer —
    // normalize treats an empty array as "no preference" and would flatten
    // the shipped default to nothing.
    //
    // #1143: the value became a per-provider map. A pre-#1143 flat list is
    // copied to every provider by coerceBuiltInMcpDefaults, so an upgrade
    // changes nobody's behavior; no store version bump is needed because this
    // coercion runs on every hydration and no persisted value changed meaning.
    //
    // Known, accepted limitation: a pre-#1143 build reads this object as "not
    // an array", normalizes it to [] and autosaves that, so downgrading and
    // then upgrading again starts every provider with no built-in defaults.
    // Writing the map under a new key would avoid it, at the cost of two keys
    // for one preference in every build from now on; downgrades are rare and
    // the loss is visible and one grid away from being restored.
    defaultBuiltInMcpDomains: parsed.defaultBuiltInMcpDomains === undefined
      ? uniformBuiltInMcpDefaults(SHIPPED_BUILT_IN_MCP_DOMAINS)
      : coerceBuiltInMcpDefaults(parsed.defaultBuiltInMcpDomains, SHIPPED_BUILT_IN_MCP_DOMAINS),
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
    // `!== false`: absent → on (the #973 default); an explicit `false` from a
    // keyboard user who reclaimed the pane height stays honored.
    mouseModeEnabled: parsed.mouseModeEnabled !== false,
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
    // Bounded and string-only: this is persisted, untrusted input, and a
    // malformed value must degrade to "nothing hidden", never a crash.
    hiddenExternalSkills: Array.isArray(parsed.hiddenExternalSkills)
      ? [...new Set(parsed.hiddenExternalSkills.filter((value: unknown): value is string =>
          typeof value === 'string' && value.length > 0 && value.length <= 512))].slice(0, 2_000)
      : [],
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

// The pre-Nord default appearance. A blob sitting on EXACTLY this pair never
// had its appearance touched — Dark was the only mode that shipped selected
// and Lime the only accent — so following the default to Nord + Frost is what
// "the default changed" means for an existing install (#973). Any other mode
// or accent is a choice the user made and is left alone.
//
// WHY this is safe to run on every hydration rather than only in `migrate`:
// after it runs the accent is 'frost', and 'lime' no longer exists as a
// selectable accent, so the condition can never be true twice. A user who
// later picks Dark again keeps Dark. Same reasoning as
// migrateLegacyCustomAppearance for living in coerceSettings: `migrate` only
// fires for older versions, `merge` coerces every launch.
// Deliberately typed `string`, not `AccentId`: 'lime' was REMOVED from the
// union, but the whole point of this check is to catch blobs persisted while
// it was still selectable. A literal-typed constant would make TS reject the
// comparison as a no-overlap error and hide the migration.
const LEGACY_DEFAULT_MODE = 'dark'
const LEGACY_DEFAULT_ACCENT: string = 'lime'

function migrateLegacyDefaultAppearance(
  parsed: Partial<Settings>,
): Pick<Settings, 'mode' | 'accent'> | null {
  if (parsed.mode !== LEGACY_DEFAULT_MODE || parsed.accent !== LEGACY_DEFAULT_ACCENT) return null
  return { mode: DEFAULT_SETTINGS.mode, accent: DEFAULT_SETTINGS.accent }
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
  // Catalog hydration happens after Settings. Erasing a valid extension id here
  // would lose the selected theme on every restart and prevent reinstall restore.
  if (isExtensionThemeMode(parsed.mode)) return parsed.mode
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
export const RETIRED_BUILT_IN_COMMAND_IDS: ReadonlySet<string> = new Set([
  'toggle-status-mode',
  'toggle-worktree-badges',
  'usage.toggle-header',
  'usage.cycle-header-level',
  'dangerous-agents',
  // Retired by the unified stage (#992). WHY this matters more than tidiness
  // (#1013 review B, MAJOR): useKeybinds' binding index puts a user's
  // customized entries AHEAD of every default and gives an id it cannot
  // resolve the `global` context. A saved `nav-left: ['Alt+H', 'Alt+Left']`
  // override therefore won ⌥H/⌥← over the new lane commands. The router
  // called preventDefault, the gateway answered `unknown`, and the chord did
  // nothing. Settings has no row for a retired id, so the user had no way to
  // find the override except "Reset all bindings".
  'dispatch-mode',
  'global-dispatch',
  'normalize-layout',
  'hard-normalize-layout',
  'rotate-layout',
  'nav-left',
  'nav-right',
  'nav-up',
  'nav-down',
  'tiled-tabs',
  'bury-pane',
  'revive-pane',
  'kill-buried-pane',
  'attach-detached-to-grid',
  'attach-all-detached-for-tab',
  'detach-to-dispatch',
  // Retired by the MCP servers interface (#1143): one staged "Agent MCP
  // Servers…" picker replaced the per-capability toggles and the reset
  // command. Listed for the same stale-override reason as the block above.
  'use-global-mcp-settings',
  'enable-ai-workspace-mcp',
  'enable-orchestration-mcp',
  'enable-agent-transcripts-mcp',
  'enable-agent-management-mcp',
  'enable-tldr-mcp',
  'enable-goal-mcp',
  'enable-goal-loop-mcp',
  'enable-workflow-mcp',
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
const RETIRED_SETTINGS_KEYS: readonly string[] = [
  'dispatchProjectTerminal',
  // Found still riding in a long-lived install's blob during the #973 audit:
  // each was a real Settings field once, and because `...parsed` copies
  // whatever it finds, every one survived every save since its field was
  // deleted. Nothing reads them; listing them here is what finally lets them
  // go. Add to this list whenever a Settings field is removed.
  'customRendering',
  'codeLineWrap',
  'showTerminalPreview',
  'showSystemEvents',
  'highContrast',
  'eventDrivenPasteSubmit',
]

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
