import {
  CUSTOM_APPEARANCE_COLOR_KEYS,
  CUSTOM_APPEARANCE_CSS_VARS,
  DEFAULT_CUSTOM_APPEARANCE,
  parseCustomAppearanceJson,
} from '@renderer/app-state/settings/customAppearance'
import type { CustomAppearanceColors } from '@renderer/app-state/settings/customAppearance'

// A saved theme's id doubles as the value of `Settings.mode`. The prefix is
// what makes that safe: built-in mode ids are a closed set of bare strings
// ('dark', 'light-soft', ...), so a prefixed id can never collide with one,
// and `isSavedThemeId` can classify a mode value without consulting the
// saved-theme list.
//
// WHY one field instead of `mode: 'custom'` plus a separate
// `activeSavedThemeId`: two fields admit an invalid state (mode is 'dark' but
// a theme id is also set) that every consumer would then have to defend
// against. applyTheme, useThemeSync, and the paired phone client all take the
// whole Settings object and ask it one question.
export const SAVED_THEME_ID_PREFIX = 'theme:'

// Names are labels, not keys. Uniqueness is deliberately NOT enforced: ids are
// already unique, and refusing a duplicate name is a papercut with no
// correctness payoff. The cap exists only so a pathological name cannot blow
// out the picker grid cell.
export const SAVED_THEME_NAME_MAX = 48

// Marks a theme created by the v4→v5 migration rather than by the user.
//
// WHY a dedicated marker instead of matching on the name "Custom": names are
// deliberately non-unique AND user-editable, so a name match makes migration
// idempotency depend on data the user controls. Concretely — create a theme you
// happen to name "Custom", downgrade to a v4 build (which rewrites version: 4
// but leaves savedThemes in the blob), then upgrade again: the migration sees
// the name, decides it already ran, and orphans the customAppearanceJson the
// user was actually looking at. The marker cannot be produced by renaming.
export const V4_CUSTOM_MIGRATION_MARKER = 'v4-custom'

export type SavedTheme = {
  id: string
  name: string
  /** Set only by the v4→v5 legacy migration; never written by the editor. */
  migratedFrom?: typeof V4_CUSTOM_MIGRATION_MARKER
  // WHY raw JSON text rather than a parsed object: the editor is a JSON
  // textarea, and users expect their formatting, key ordering, and blank lines
  // to survive a round trip. Storing parsed objects would silently reformat
  // every theme on every save. Validity is enforced at the two boundaries that
  // matter — save time (blocks the save) and load time (coerceSavedThemes
  // drops entries that no longer parse).
  json: string
  createdAt: number
  updatedAt: number
}

export function isSavedThemeId(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(SAVED_THEME_ID_PREFIX)
}

export function mintSavedThemeId(): string {
  return `${SAVED_THEME_ID_PREFIX}${crypto.randomUUID()}`
}

export function createSavedTheme(
  name: string,
  json: string,
  migratedFrom?: typeof V4_CUSTOM_MIGRATION_MARKER,
): SavedTheme {
  const now = Date.now()
  return {
    id: mintSavedThemeId(),
    name: name.trim().slice(0, SAVED_THEME_NAME_MAX),
    json,
    createdAt: now,
    updatedAt: now,
    ...(migratedFrom ? { migratedFrom } : {}),
  }
}

export function isV4MigratedTheme(theme: SavedTheme): boolean {
  return theme.migratedFrom === V4_CUSTOM_MIGRATION_MARKER
}

// Mirrors normalizeCustomTemplates in the prompt-templates feature: drop
// anything malformed rather than letting one bad entry poison the list.
//
// WHY the load path parses LENIENTLY: only structurally hopeless JSON (not an
// object, unparseable text) costs a theme its place in the list. A theme
// carrying a key we no longer recognize — which is what a future token rename
// produces for every theme authored before it — keeps working with that key
// ignored. Strict parsing here would mean a one-line rename in
// CUSTOM_APPEARANCE_COLOR_KEYS silently deletes every saved theme at boot.
export function coerceSavedThemes(value: unknown): SavedTheme[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    if (!isSavedThemeId(record.id)) return []
    if (typeof record.name !== 'string' || !record.name.trim()) return []
    if (typeof record.json !== 'string') return []
    if (seen.has(record.id)) return []
    try {
      parseCustomAppearanceJson(record.json, 'lenient')
    } catch {
      return []
    }
    seen.add(record.id)
    return [{
      id: record.id,
      name: record.name.trim().slice(0, SAVED_THEME_NAME_MAX),
      json: record.json,
      createdAt: typeof record.createdAt === 'number' ? record.createdAt : 0,
      updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
      ...(record.migratedFrom === V4_CUSTOM_MIGRATION_MARKER
        ? { migratedFrom: V4_CUSTOM_MIGRATION_MARKER }
        : {}),
    }]
  })
}

export function findSavedTheme(themes: SavedTheme[], id: string): SavedTheme | null {
  return themes.find(theme => theme.id === id) ?? null
}

export function resolveSavedThemeColors(theme: SavedTheme): CustomAppearanceColors | null {
  try {
    // Lenient for the same reason coerceSavedThemes is: an unrecognized key
    // must not stop a theme the user can see in the picker from rendering.
    return parseCustomAppearanceJson(theme.json, 'lenient')
  } catch {
    // Unreachable for themes that came through coerceSavedThemes, which
    // already dropped unparseable entries. Kept because this function is also
    // reachable from paths where the payload has not been vetted yet.
    return null
  }
}

// Read the 81 currently-applied token values straight off <html>.
//
// WHY the DOM is the source rather than a TypeScript palette table: built-in
// themes exist ONLY as CSS in `[data-mode]` blocks in styles.css. THEME_MODES
// carries {id, label, family} and nothing else, so there is no way to ask
// TypeScript "what hex is Tokyonight's canvas?". This is the same mechanism
// readXtermTheme() and the Monaco theme bridges already use, so it is an
// established pattern here rather than a new one.
//
// This is what lets "+ New theme…" seed from whatever the user is currently
// looking at instead of from a blank object. A blank or sparse seed would
// render as an unreadable mess the instant it applied, because the user would
// then be editing a theme sharing almost nothing with the one they just had.
//
// Falls back per-token to DEFAULT_CUSTOM_APPEARANCE when a variable reads
// empty, which can only happen if this is called before the first applyTheme.
export function readAppliedAppearance(): CustomAppearanceColors {
  if (typeof document === 'undefined') return { ...DEFAULT_CUSTOM_APPEARANCE }
  const styles = getComputedStyle(document.documentElement)
  const colors = {} as CustomAppearanceColors
  for (const key of CUSTOM_APPEARANCE_COLOR_KEYS) {
    const value = styles.getPropertyValue(CUSTOM_APPEARANCE_CSS_VARS[key]).trim()
    colors[key] = value || DEFAULT_CUSTOM_APPEARANCE[key]
  }
  return colors
}
