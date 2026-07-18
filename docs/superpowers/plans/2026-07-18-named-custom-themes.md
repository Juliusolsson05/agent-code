# Named Custom Themes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user save a custom color scheme under a name, pick it from the Settings theme grid, and edit or delete it later — replacing the single unnamed `customAppearanceJson` slot.

**Architecture:** `Settings.savedThemes: SavedTheme[]` holds named themes whose ids (`theme:<uuid>`) double as the value of `Settings.mode`, so one field still answers "what am I looking at." A new pure `resolveThemePayload(settings)` becomes the seam between "which theme" and "what colors"; `applyTheme` calls it instead of branching on `mode === 'custom'`. New themes seed from `getComputedStyle` on `<html>`, which is the only way to reach built-in palettes that exist solely as CSS in `[data-mode]` blocks.

**Tech Stack:** TypeScript, React 19, Zustand (+ `persist`), Tailwind v4 CSS-first config, Electron, shadcn-derived `components/ui` primitives.

**Spec:** `docs/superpowers/specs/2026-07-18-named-custom-themes-design.md`
**Issue:** #566
**Branch:** `feat/named-custom-themes` (worktree `.worktrees/named-themes`)

## Global Constraints

- **No new test files.** This repo's convention is that feature PRs do not add tests or wire new `test:*` scripts; a test-cleanup PR is planned separately. Temporary throwaway fixtures are fine but must not be committed. Every task below therefore gates on `tsc` plus driving the real app, not on a committed spec file.
- **Verification is raw `tsc` on both projects.** `electron-vite build` and `vitest` do not type-check. Run `npx tsc -p tsconfig.node.json --noEmit` and `npx tsc -p tsconfig.web.json --noEmit`.
- **Fresh worktrees need setup before `tsc` resolves:** `git submodule update --init --recursive` (slow, several minutes) and `ln -sfn ../../node_modules node_modules`. Pre-existing errors on `main` in `catalogCoverage.ts` and `committed.ts` are not yours.
- **Thick WHY comments are mandatory** (see `CLAUDE.md`). Explain why a shape was chosen and what would make it wrong. Do not explain what the code does.
- **No border-radius, monospace everywhere.** `styles.css:15-36` states these as hard aesthetic rules; don't deviate.
- **Never add a token.** `CUSTOM_APPEARANCE_COLOR_KEYS` (81 entries) is unchanged by this work.
- **Do not remove `Settings.customAppearanceJson`.** It stays vestigial after migration; removing it is a separate cleanup once v5 has shipped.
- Commit after each task. Do not push until Task 8.

---

### Task 1: `savedThemes` module — types, resolution, and the DOM seeder

**Files:**
- Create: `src/renderer/src/app-state/settings/savedThemes.ts`
- Create: `src/renderer/src/lib/color/luminance.ts`
- Modify: `src/renderer/src/workspace/tile-tree/xtermTheme.ts:14-24` (delete the local copy, import the shared one)

**Interfaces:**
- Consumes: `CUSTOM_APPEARANCE_COLOR_KEYS`, `CUSTOM_APPEARANCE_CSS_VARS`, `DEFAULT_CUSTOM_APPEARANCE`, `parseCustomAppearanceJson`, `CustomAppearanceColors` from `customAppearance.ts`.
- Produces:
  - `type SavedTheme = { id: string; name: string; json: string; createdAt: number; updatedAt: number }`
  - `SAVED_THEME_ID_PREFIX: 'theme:'`
  - `isSavedThemeId(value: unknown): value is string`
  - `mintSavedThemeId(): string`
  - `createSavedTheme(name: string, json: string): SavedTheme`
  - `coerceSavedThemes(value: unknown): SavedTheme[]`
  - `findSavedTheme(themes: SavedTheme[], id: string): SavedTheme | null`
  - `resolveSavedThemeColors(theme: SavedTheme): CustomAppearanceColors | null`
  - `readAppliedAppearance(): CustomAppearanceColors`
  - `relativeLuminance(hex: string): number | null` (from the new `lib/color/luminance.ts`)

- [ ] **Step 1: Extract the luminance helper so two callers can share it**

`xtermTheme.ts` has a private `relativeLuminance`. `savedThemes` needs the same math to decide whether a user's theme is light or dark. Create `src/renderer/src/lib/color/luminance.ts`:

```ts
// WHY this lives in lib/color instead of staying private to xtermTheme:
// two unrelated consumers now need the same question answered — xterm picks
// its ANSI ramp from background luminance, and saved themes decide their
// light/dark family the same way. Duplicating the sRGB transfer function
// would be the kind of quiet divergence that makes a light custom theme
// render dark ANSI colors months later with no obvious cause.
//
// Returns null for anything that is not a 6-digit hex. Callers must decide
// what an unknown color means; this function refuses to guess. Note that
// custom appearance values are validated against a much wider grammar
// (rgb(), oklch(), color-mix(), bare identifiers...), so null is a normal
// result here, not an error.
export function relativeLuminance(hex: string): number | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim())
  if (!match) return null
  const [r, g, b] = [0, 2, 4].map(offset => {
    const channel = Number.parseInt(match[1].slice(offset, offset + 2), 16) / 255
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
```

- [ ] **Step 2: Point `xtermTheme.ts` at the shared helper**

Delete lines 14-24 of `src/renderer/src/workspace/tile-tree/xtermTheme.ts` (the local `relativeLuminance` function) and add to its imports:

```ts
import { relativeLuminance } from '@renderer/lib/color/luminance'
```

Leave every call site (`relativeLuminance(background)`) untouched.

- [ ] **Step 3: Create `savedThemes.ts`**

```ts
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
// `activeSavedThemeId`: two fields admit an invalid state (mode is 'dark'
// but a theme id is also set) that every consumer would have to defend
// against. applyTheme, useThemeSync, and the paired phone client all take
// the whole Settings object and ask one question of it.
export const SAVED_THEME_ID_PREFIX = 'theme:'

export type SavedTheme = {
  id: string
  name: string
  // WHY raw JSON text rather than a parsed object: the editor is a JSON
  // textarea, and users expect their formatting, key ordering, and blank
  // lines to survive a round trip. Storing parsed objects would silently
  // reformat every theme on every save. Validity is enforced at the two
  // boundaries that matter — save time (blocks the save) and load time
  // (coerceSavedThemes drops entries that no longer parse).
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

// Names are labels, not keys. Uniqueness is deliberately NOT enforced:
// ids are already unique, and refusing a duplicate name is a papercut with
// no correctness payoff. The cap exists only so a pathological name cannot
// blow out the picker grid cell.
export const SAVED_THEME_NAME_MAX = 48

export function createSavedTheme(name: string, json: string): SavedTheme {
  const now = Date.now()
  return {
    id: mintSavedThemeId(),
    name: name.trim().slice(0, SAVED_THEME_NAME_MAX),
    json,
    createdAt: now,
    updatedAt: now,
  }
}

// Mirrors normalizeCustomTemplates in the prompt-templates feature: drop
// anything malformed rather than letting one bad entry poison the list.
//
// WHY invalid JSON is dropped here but missing *keys* are not: a theme whose
// json no longer parses cannot be applied at all, so keeping it would put an
// unusable cell in the picker. A theme merely missing newly-added tokens is
// still perfectly applicable — parseCustomAppearanceJson backfills those from
// DEFAULT_CUSTOM_APPEARANCE, which is what keeps old themes alive as the
// token set grows.
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
      parseCustomAppearanceJson(record.json)
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
    }]
  })
}

export function findSavedTheme(themes: SavedTheme[], id: string): SavedTheme | null {
  return themes.find(theme => theme.id === id) ?? null
}

export function resolveSavedThemeColors(theme: SavedTheme): CustomAppearanceColors | null {
  try {
    return parseCustomAppearanceJson(theme.json)
  } catch {
    // Unreachable for themes that came through coerceSavedThemes, which
    // already dropped unparseable entries. Kept because this function is
    // also reachable from the editor's live draft path, where the payload
    // has not been vetted yet.
    return null
  }
}

// Read the 81 currently-applied token values straight off <html>.
//
// WHY the DOM is the source rather than a TypeScript palette table: built-in
// themes exist ONLY as CSS in `[data-mode]` blocks in styles.css. THEME_MODES
// carries {id, label, family} and nothing else, so there is no way to ask
// TypeScript "what hex is Tokyonight's canvas?" This is the same mechanism
// readXtermTheme() and the Monaco theme bridges already use, so it is an
// established pattern here rather than a new one.
//
// This is what makes "+ New theme…" seed from whatever the user is currently
// looking at instead of a blank object. A blank or sparse seed would render
// as an unreadable mess the instant it applied, because the user would then
// be editing a theme sharing almost nothing with the one they just had.
//
// Falls back per-token to DEFAULT_CUSTOM_APPEARANCE when a variable reads
// empty, which happens if this is somehow called before the first applyTheme.
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
```

- [ ] **Step 4: Type-check**

Run: `npx tsc -p tsconfig.web.json --noEmit 2>&1 | grep -E "savedThemes|luminance|xtermTheme"`
Expected: no output (the file compiles; unrelated pre-existing errors elsewhere are fine).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/app-state/settings/savedThemes.ts src/renderer/src/lib/color/luminance.ts src/renderer/src/workspace/tile-tree/xtermTheme.ts
git commit -m "feat(themes): add SavedTheme model, coercion, and DOM appearance seeder"
```

---

### Task 2: Widen the Settings type and retire the `custom` sentinel

**Files:**
- Modify: `src/renderer/src/app-state/settings/types.ts:4-34` (mode union, `THEME_MODES`, `isDarkThemeMode`) and the `Settings` type + `DEFAULT_SETTINGS`

**Interfaces:**
- Consumes: `SavedTheme`, `isSavedThemeId`, `findSavedTheme`, `resolveSavedThemeColors`, `relativeLuminance` from Task 1.
- Produces: `type ThemeMode` (now built-ins only), `type ThemeModeValue = ThemeMode | string`, `Settings.savedThemes`, `isDarkThemeValue(mode, savedThemes)`.

- [ ] **Step 1: Narrow `ThemeMode`, drop the sentinel, delete the stale grid comment**

Replace `types.ts:4-34` with:

```ts
// Built-in theme ids only. 'custom' used to live here as a sentinel that
// rendered as a picker cell but acted as a button (it opened the JSON editor
// instead of setting the mode). Named saved themes replaced it: a saved theme
// is a real, selectable value, so the fake entry — and the comment explaining
// that it sat at index 5 to make the Appearance grid an even 3x2 — are gone.
// The grid is now variable-length and always ends with a "+ New theme…" cell.
export type ThemeMode =
  | 'dark'
  | 'dark-dim'
  | 'dark-tokyonight'
  | 'light'
  | 'light-soft'

// What `Settings.mode` may hold: a built-in id, or a `theme:<uuid>` saved
// theme id. Kept as a distinct alias so the many call sites that only care
// about built-ins can keep using ThemeMode.
export type ThemeModeValue = ThemeMode | string

export type ThemeModeMeta = {
  id: ThemeMode
  label: string
  family: 'dark' | 'light'
}

export const THEME_MODES: ThemeModeMeta[] = [
  { id: 'dark', label: 'Dark', family: 'dark' },
  { id: 'dark-dim', label: 'Gray Dark', family: 'dark' },
  { id: 'dark-tokyonight', label: 'Tokyonight', family: 'dark' },
  { id: 'light', label: 'Light', family: 'light' },
  { id: 'light-soft', label: 'Soft Light', family: 'light' },
]

export function isBuiltInThemeMode(value: unknown): value is ThemeMode {
  return THEME_MODES.some(option => option.id === value)
}

// Retained for the many callers that pass a built-in id. Anything not in the
// light family counts as dark, which is why a saved theme must NOT be routed
// through here — see isDarkThemeValue.
export function isDarkThemeMode(mode: ThemeModeValue): boolean {
  return THEME_MODES.find(option => option.id === mode)?.family !== 'light'
}
```

- [ ] **Step 2: Add the saved-theme-aware light/dark resolver**

Append to `types.ts` (it needs the Task 1 imports at the top of the file):

```ts
import { findSavedTheme, isSavedThemeId, resolveSavedThemeColors } from '@renderer/app-state/settings/savedThemes'
import type { SavedTheme } from '@renderer/app-state/settings/savedThemes'
import { relativeLuminance } from '@renderer/lib/color/luminance'

// WHY a saved theme cannot use isDarkThemeMode: that function returns true
// for anything not in the light family, so every user theme would be treated
// as dark. That was tolerable when there was one unnamed custom slot; with
// named themes a user's light theme is a first-class thing and getting its
// family wrong picks the wrong accent pair.
//
// We infer from the theme's own canvas luminance, the same signal xterm
// already uses to choose its ANSI ramp, so the chrome and the terminal agree.
// A canvas expressed as rgb()/oklch()/color-mix() returns null from
// relativeLuminance — we fall back to dark, matching the historical default.
export function isDarkThemeValue(mode: ThemeModeValue, savedThemes: SavedTheme[]): boolean {
  if (!isSavedThemeId(mode)) return isDarkThemeMode(mode)
  const theme = findSavedTheme(savedThemes, mode)
  if (!theme) return true
  const colors = resolveSavedThemeColors(theme)
  if (!colors) return true
  const luminance = relativeLuminance(colors.canvas)
  if (luminance === null) return true
  return luminance <= 0.5
}
```

- [ ] **Step 3: Add `savedThemes` to `Settings` and `DEFAULT_SETTINGS`**

In the `Settings` type, change `mode: ThemeMode` to `mode: ThemeModeValue` and add:

```ts
  // Named custom color schemes. The active one is identified by
  // `mode` holding its id; see savedThemes.ts for why that is one
  // field rather than two.
  savedThemes: SavedTheme[]
```

In `DEFAULT_SETTINGS`, add `savedThemes: []`. Leave `customAppearanceJson: DEFAULT_CUSTOM_APPEARANCE_JSON` exactly as it is — it stays for the migration and for downgrade safety.

- [ ] **Step 4: Type-check and fix fallout**

Run: `npx tsc -p tsconfig.web.json --noEmit 2>&1 | grep -v "TS6305"`
Expected: errors at every site that assumed `mode === 'custom'` or `family: 'custom'`. Fix each by deleting the custom branch — the two known sites are `THEME_MODE_OPTIONS` in `settingsRegistry.ts:151-157` (drop the `family === 'custom'` ternary arm, leaving the light/dark description) and `AppearanceMenu.tsx` (Task 7). Do not silence errors with casts.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/app-state/settings/types.ts src/renderer/src/features/settings/lib/settingsRegistry.ts
git commit -m "feat(themes): widen Settings.mode to saved theme ids, drop custom sentinel"
```

---

### Task 3: Route `applyTheme` through payload resolution

**Files:**
- Modify: `src/renderer/src/app-state/settings/theme.ts:42-104`

**Interfaces:**
- Consumes: `isSavedThemeId`, `findSavedTheme`, `resolveSavedThemeColors` (Task 1); `isDarkThemeValue` (Task 2).
- Produces: `resolveThemePayload(settings: Settings): CustomAppearanceColors | null`.

- [ ] **Step 1: Add the resolver**

Add to `theme.ts` above `applyTheme`:

```ts
// The seam between "which theme" and "what colors". Returns null for
// built-in modes, meaning "no inline overrides — let the [data-mode] CSS
// block win and run the accent path."
//
// WHY a deleted theme falls back to null rather than to the legacy custom
// payload: a saved theme id can outlive its theme (deleted in this window,
// or a Settings blob synced from a machine that has different themes). The
// safe degradation is a built-in theme that definitely renders, not a
// half-remembered palette the user may never have seen.
export function resolveThemePayload(settings: Settings): CustomAppearanceColors | null {
  if (isSavedThemeId(settings.mode)) {
    const theme = findSavedTheme(settings.savedThemes, settings.mode)
    if (!theme) return null
    return resolveSavedThemeColors(theme)
  }
  // Transitional: a v4 blob that skipped migration can still say 'custom'.
  // coerceSettings migrates these into a saved theme, so this branch should
  // be unreachable in practice — it exists so a partially-migrated state
  // renders the user's colors instead of silently reverting to Dark.
  if (settings.mode === 'custom') {
    try {
      return parseCustomAppearanceJson(settings.customAppearanceJson)
    } catch {
      return null
    }
  }
  return null
}
```

- [ ] **Step 2: Rewrite the `applyTheme` body's theme branch**

Replace lines 51-62 with:

```ts
  // WHY data-mode gets 'custom' for saved themes rather than the raw id:
  // styles.css keys its blocks off known values, and an unknown data-mode
  // matches no block — which is exactly right here, because the inline
  // properties written below fully define the palette. Writing a literal
  // 'custom' keeps any existing `[data-mode="custom"]` styling and debug
  // tooling working without teaching them about uuids.
  const payload = resolveThemePayload(settings)
  root.dataset.mode = payload ? 'custom' : settings.mode
  root.dataset.contrast = settings.contrast ? 'high' : 'normal'
  if (payload) {
    applyCustomAppearance(root, payload)
  } else {
    clearCustomAppearance(root)
    const accent = ACCENTS.find(a => a.id === settings.accent) ?? ACCENTS[0]
    const dark = isDarkThemeValue(settings.mode, settings.savedThemes)
    root.style.setProperty('--theme-accent', dark ? accent.dark : accent.light)
    root.style.setProperty('--theme-accent-fg', dark ? accent.fgDark : accent.fgLight)
  }
```

- [ ] **Step 3: Change `applyCustomAppearance` to take resolved colors**

It currently takes a raw string and parses internally. Resolution now happens in `resolveThemePayload`, so:

```ts
function applyCustomAppearance(root: HTMLElement, colors: CustomAppearanceColors): void {
  // WHY custom mode writes every color token inline instead of generating a
  // stylesheet block: the built-in themes are static CSS keyed by
  // `[data-mode]`, but user JSON is runtime data from persisted settings.
  // Inline custom properties on `<html>` are the same mechanism the existing
  // accent picker already uses, and they deliberately outrank the mode blocks
  // in styles.css. That gives live updates with zero React re-render plumbing
  // and keeps Monaco/xterm listeners on the existing theme-changed event.
  for (const key of CUSTOM_APPEARANCE_COLOR_KEYS) {
    root.style.setProperty(CUSTOM_APPEARANCE_CSS_VARS[key], colors[key])
  }
}
```

Leave `clearCustomAppearance` and its WHY comment untouched — it is what stops a stale palette from outranking every `[data-mode]` block, and it now runs whenever the payload is null.

- [ ] **Step 4: Type-check**

Run: `npx tsc -p tsconfig.web.json --noEmit 2>&1 | grep -E "theme\.ts"`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/app-state/settings/theme.ts
git commit -m "feat(themes): resolve applyTheme payload from saved themes"
```

---

### Task 4: Coercion and the v5 migration

**Files:**
- Modify: `src/renderer/src/app-state/settings/persistence.ts:19-33`
- Modify: `src/renderer/src/app-state/store.ts:23-36`

**Interfaces:**
- Consumes: `coerceSavedThemes`, `createSavedTheme`, `isSavedThemeId`, `findSavedTheme` (Task 1); `isBuiltInThemeMode` (Task 2).
- Produces: `coerceSettings` accepting saved-theme modes; persisted version 5.

- [ ] **Step 1: Coerce `savedThemes` before validating `mode`**

In `coerceSettings`, replace the `mode:` entry and add `savedThemes:`. **Order matters** — compute the themes first, in a `const` above the returned object:

```ts
export function coerceSettings(value: unknown): Settings {
  const parsed = value && typeof value === 'object'
    ? value as Partial<Settings>
    : {}

  // WHY savedThemes is computed before the returned object rather than
  // inline: `mode` validity depends on which themes survived coercion — a
  // mode pointing at a theme that was just dropped for unparseable JSON must
  // fall back to the default. Doing both inline would read the raw,
  // un-coerced array and could leave mode pointing at a theme that no longer
  // exists, which renders as Dark with no inline properties and looks like
  // the setting silently reset itself.
  const savedThemes = migrateLegacyCustomAppearance(parsed, coerceSavedThemes(parsed.savedThemes))

  return {
    ...DEFAULT_SETTINGS,
    ...parsed,
    savedThemes,
    mode: resolvePersistedMode(parsed, savedThemes),
    // ...everything else unchanged
  }
}
```

- [ ] **Step 2: Add the two helpers below `coerceSettings`**

```ts
// v4 and earlier had exactly one unnamed custom palette, selected by
// `mode === 'custom'`. Converting it into a real saved theme is what keeps
// an upgrading user looking at the same colors they had before the update.
//
// WHY this lives in coerceSettings instead of only in `migrate`: zustand
// calls `migrate` only when the stored version is older, but same-version
// blobs can still be stale (interrupted writes, hand-edited localStorage, a
// dev build that ran a branch). Coercion runs on every launch through
// `merge`, so putting the conversion here makes it idempotent and
// unconditional. The `already migrated` guard is what makes re-running safe.
function migrateLegacyCustomAppearance(
  parsed: Partial<Settings>,
  savedThemes: SavedTheme[],
): SavedTheme[] {
  if (parsed.mode !== 'custom') return savedThemes
  if (savedThemes.some(theme => theme.name === LEGACY_CUSTOM_THEME_NAME)) return savedThemes
  const raw = typeof parsed.customAppearanceJson === 'string'
    ? parsed.customAppearanceJson
    : ''
  try {
    parseCustomAppearanceJson(raw)
  } catch {
    // Matches the pre-existing coerceCustomAppearanceJson policy: an
    // unparseable payload silently degrades rather than blocking boot.
    // The user lands on Dark, which is what they would have seen anyway.
    return savedThemes
  }
  return [createSavedTheme(LEGACY_CUSTOM_THEME_NAME, raw), ...savedThemes]
}

const LEGACY_CUSTOM_THEME_NAME = 'Custom'

// Accepts a built-in id, or a saved theme id that actually resolves. Anything
// else — a typo, a theme deleted on another machine, the legacy 'custom'
// sentinel whose migration just produced a real theme — falls back.
function resolvePersistedMode(
  parsed: Partial<Settings>,
  savedThemes: SavedTheme[],
): Settings['mode'] {
  if (parsed.mode === 'custom') {
    const migrated = savedThemes.find(theme => theme.name === LEGACY_CUSTOM_THEME_NAME)
    return migrated ? migrated.id : DEFAULT_SETTINGS.mode
  }
  if (isBuiltInThemeMode(parsed.mode)) return parsed.mode
  if (isSavedThemeId(parsed.mode) && findSavedTheme(savedThemes, parsed.mode)) {
    return parsed.mode
  }
  return DEFAULT_SETTINGS.mode
}
```

- [ ] **Step 3: Bump the persisted version to 5**

In `store.ts`, change `version: 4` to `version: 5` and append to the existing comment block (keep every prior paragraph — it is the record of the #249 black-screen incident):

```ts
        // v5 adds `settings.savedThemes` and widens `settings.mode` to hold
        // a `theme:<uuid>` id. Without a bump, an existing v4 user on
        // `mode: 'custom'` would skip migration, keep a mode value that no
        // longer resolves to anything, and boot to Dark with their custom
        // palette silently orphaned in customAppearanceJson.
        version: 5,
```

- [ ] **Step 4: Type-check both projects**

Run: `npx tsc -p tsconfig.node.json --noEmit 2>&1 | grep -E "persistence|store\.ts"` then `npx tsc -p tsconfig.web.json --noEmit 2>&1 | grep -E "persistence|store\.ts"`
Expected: no output from either.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/app-state/settings/persistence.ts src/renderer/src/app-state/store.ts
git commit -m "feat(themes): coerce saved themes and migrate legacy custom appearance to v5"
```

---

### Task 5: The theme picker row

**Files:**
- Create: `src/renderer/src/features/settings/ui/ThemePickerRow.tsx`
- Modify: `src/renderer/src/features/settings/lib/settingsRegistry.ts:22-29` (context), `:225-244` (the `theme-mode` entry), and the `SettingDefinition` union
- Modify: `src/renderer/src/features/settings/ui/SettingsList.tsx` (render the new marker)

**Interfaces:**
- Consumes: `SavedTheme` (Task 1); `THEME_MODES`, `isBuiltInThemeMode` (Task 2).
- Produces: `<ThemePickerRow settings onChange onCreate onEdit onDelete />`; `SettingActionContext` gains `openThemeEditor(themeId: string | null)` and `deleteSavedTheme(themeId: string)`.

- [ ] **Step 1: Replace the `select` control with a marker**

The generic `select` control renders a flat grid of value cells and has no room for per-option Edit/Delete actions. Add a marker variant to the `SettingDefinition` union, matching how `cli-update-behavior` and `dictation-api-key` already handle rows whose rendering exceeds the generic controls:

```ts
  | {
      id: string
      category: SettingCategoryId
      title: string
      description: string
      keywords: string[]
      // Marker for the theme grid. The generic `select` control renders
      // uniform value cells; this row needs per-cell Edit/Delete affordances
      // on saved themes and a trailing "+ New theme…" cell that is an action
      // rather than a value. Same escape hatch as cli-update-behavior.
      // See features/settings/ui/ThemePickerRow.tsx.
      control: {
        type: 'theme-picker'
      }
    }
```

Then replace the `theme-mode` registry entry (`:225-244`) with:

```ts
    {
      id: 'theme-mode',
      category: 'appearance',
      title: 'Theme',
      description: 'Switch between built-in themes and your saved color schemes.',
      keywords: ['theme', 'mode', 'dark', 'light', 'tokyonight', 'dim', 'custom', 'color', 'scheme', 'saved'],
      control: { type: 'theme-picker' },
    },
```

Delete the now-unused `THEME_MODE_OPTIONS` constant at `:151-157`.

- [ ] **Step 2: Extend `SettingActionContext`**

```ts
export type SettingActionContext = {
  workspace: Workspace
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  onReset: () => void
  onClose: () => void
  // null means "create a new theme seeded from what is currently applied";
  // an id means "edit that saved theme".
  openThemeEditor: (themeId: string | null) => void
  deleteSavedTheme: (themeId: string) => void
}
```

Remove `openCustomAppearanceEditor` — `openThemeEditor(null)` replaces it. Fix the one call site in `SettingsPage.tsx:99` as part of Task 6.

- [ ] **Step 3: Write `ThemePickerRow.tsx`**

```tsx
import { Button } from '@renderer/components/ui/button'
import { THEME_MODES } from '@renderer/app-state/settings/types'
import type { Settings } from '@renderer/app-state/settings/types'
import type { SavedTheme } from '@renderer/app-state/settings/savedThemes'

type Props = {
  settings: Settings
  onSelect: (mode: string) => void
  onCreate: () => void
  onEdit: (theme: SavedTheme) => void
  onDelete: (theme: SavedTheme) => void
}

// WHY saved themes sit in the same grid as built-ins rather than in a
// separate "My Themes" section: a saved theme IS a theme, and segregating
// user content into a second-class list below the "real" options is how a
// feature ends up unused. There is direct precedent — the command palette
// lists custom prompt templates alongside built-ins, tagged with their scope
// and carrying inline Edit/Delete buttons. Matching that shape gives the app
// one mental model for "built-in vs mine".
export function ThemePickerRow({ settings, onSelect, onCreate, onEdit, onDelete }: Props) {
  return (
    <div className="grid grid-cols-2 gap-px bg-panel-border">
      {THEME_MODES.map(mode => (
        <button
          key={mode.id}
          type="button"
          onClick={() => onSelect(mode.id)}
          className={`flex items-center justify-between px-3 py-2 text-left text-[12px] ${
            settings.mode === mode.id
              ? 'bg-row-selected-bg text-row-selected-fg'
              : 'bg-row-bg text-ink-dim hover:bg-row-hover-bg'
          }`}
        >
          <span className="truncate">{mode.label}</span>
          <span className="flex-shrink-0 text-[9px] uppercase tracking-wider text-muted">
            {mode.family}
          </span>
        </button>
      ))}

      {settings.savedThemes.map(theme => (
        <div
          key={theme.id}
          className={`group flex items-center justify-between gap-2 px-3 py-2 text-[12px] ${
            settings.mode === theme.id
              ? 'bg-row-selected-bg text-row-selected-fg'
              : 'bg-row-bg text-ink-dim hover:bg-row-hover-bg'
          }`}
        >
          <button
            type="button"
            onClick={() => onSelect(theme.id)}
            className="min-w-0 flex-1 truncate text-left"
          >
            {theme.name}
          </button>
          {/* Actions replace the CUSTOM tag on hover so the resting grid
              stays quiet. group-hover alone would strand keyboard users,
              so focus-within reveals them too. */}
          <span className="flex-shrink-0 text-[9px] uppercase tracking-wider text-muted group-hover:hidden group-focus-within:hidden">
            custom
          </span>
          <span className="hidden flex-shrink-0 items-center gap-1 group-hover:flex group-focus-within:flex">
            <Button type="button" size="sm" variant="secondary" onClick={() => onEdit(theme)}>
              Edit
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => onDelete(theme)}>
              Delete
            </Button>
          </span>
        </div>
      ))}

      {/* Always the last cell, so the grid stays a filled rectangle as
          themes are added rather than leaving a hole mid-grid. */}
      <button
        type="button"
        onClick={onCreate}
        className="flex items-center px-3 py-2 text-left text-[12px] bg-row-bg text-muted hover:bg-row-hover-bg hover:text-ink"
      >
        + New theme…
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Render the marker in `SettingsList.tsx`**

Find the existing marker dispatch (`control.type === 'cli-update-behavior'`) and add the sibling branch, wiring each callback to the action context:

```tsx
        {definition.control.type === 'theme-picker' ? (
          <ThemePickerRow
            settings={settings}
            onSelect={mode => actionContext.onChange({ mode })}
            onCreate={() => actionContext.openThemeEditor(null)}
            onEdit={theme => actionContext.openThemeEditor(theme.id)}
            onDelete={theme => actionContext.deleteSavedTheme(theme.id)}
          />
        ) : null}
```

- [ ] **Step 5: Type-check**

Run: `npx tsc -p tsconfig.web.json --noEmit 2>&1 | grep -E "ThemePickerRow|SettingsList|settingsRegistry"`
Expected: one error at `SettingsPage.tsx` for the removed `openCustomAppearanceEditor`. That is Task 6's job; everything else clean.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/features/settings/ui/ThemePickerRow.tsx src/renderer/src/features/settings/ui/SettingsList.tsx src/renderer/src/features/settings/lib/settingsRegistry.ts
git commit -m "feat(themes): render built-in and saved themes in one picker grid"
```

---

### Task 6: The named theme editor

**Files:**
- Modify: `src/renderer/src/features/settings/ui/SettingsPage.tsx:60-211`

**Interfaces:**
- Consumes: `createSavedTheme`, `findSavedTheme`, `readAppliedAppearance`, `SAVED_THEME_NAME_MAX` (Task 1); `openThemeEditor` / `deleteSavedTheme` context shape (Task 5).
- Produces: nothing downstream — this is the last consumer.

- [ ] **Step 1: Replace the modal's open-state with an editor target**

`customAppearanceOpen: boolean` cannot express "editing which theme." Replace it:

```tsx
  // null  → closed
  // {id: null}   → creating, seeded from the applied appearance
  // {id: '...'}  → editing that saved theme
  const [editorTarget, setEditorTarget] = useState<{ id: string | null } | null>(null)
```

- [ ] **Step 2: Wire the action context**

```tsx
              openThemeEditor: (themeId: string | null) => setEditorTarget({ id: themeId }),
              deleteSavedTheme: (themeId: string) => {
                // WHY no confirmation dialog: prompt-template delete has none
                // either, and a theme is cheap to recreate. If this proves
                // wrong, a confirm is a one-line addition.
                //
                // Falling back to the default mode when the ACTIVE theme is
                // deleted is what triggers applyTheme's clear-all path; without
                // it the inline properties would keep outranking every
                // [data-mode] block and the app would look broken until reload.
                const savedThemes = settings.savedThemes.filter(theme => theme.id !== themeId)
                onChange({
                  savedThemes,
                  mode: settings.mode === themeId ? DEFAULT_SETTINGS.mode : settings.mode,
                })
              },
```

- [ ] **Step 3: Render the editor**

```tsx
      {editorTarget ? (
        <ThemeEditorModal
          theme={editorTarget.id ? findSavedTheme(settings.savedThemes, editorTarget.id) : null}
          onClose={() => setEditorTarget(null)}
          onSave={(name, json, asCopy) => {
            const existing = editorTarget.id
              ? findSavedTheme(settings.savedThemes, editorTarget.id)
              : null
            if (existing && !asCopy) {
              const updated = { ...existing, name, json, updatedAt: Date.now() }
              onChange({
                savedThemes: settings.savedThemes.map(t => (t.id === existing.id ? updated : t)),
                mode: updated.id,
              })
            } else {
              const created = createSavedTheme(name, json)
              onChange({
                savedThemes: [...settings.savedThemes, created],
                mode: created.id,
              })
            }
            setEditorTarget(null)
          }}
        />
      ) : null}
```

- [ ] **Step 4: Rewrite `CustomAppearanceModal` as `ThemeEditorModal`**

Keep the whole existing body — the `json`/`schema` toggle, the read-only schema `<pre>`, the textarea styling, the save-time error line. Change the signature, seed the draft, add the name field, and add the third button:

```tsx
function ThemeEditorModal({
  theme,
  onClose,
  onSave,
}: {
  theme: SavedTheme | null
  onClose: () => void
  onSave: (name: string, json: string, asCopy: boolean) => void
}) {
  // WHY a new theme seeds from readAppliedAppearance() rather than from
  // DEFAULT_CUSTOM_APPEARANCE: it means "duplicate what I am looking at",
  // so the very first save is the user's current theme plus their one edit.
  // Seeding from the hardcoded dark default would drop a Tokyonight user
  // into an unrecognizable palette the moment they saved. It is also the
  // only way to reach built-in palette values at all — they exist solely as
  // CSS in [data-mode] blocks (see savedThemes.ts).
  const [draft, setDraft] = useState(
    () => theme?.json ?? stringifyCustomAppearance(readAppliedAppearance()),
  )
  const [name, setName] = useState(theme?.name ?? '')
  const [view, setView] = useState<'json' | 'schema'>('json')
  const [error, setError] = useState<string | null>(null)

  const save = (asCopy: boolean) => {
    const trimmed = name.trim()
    if (!trimmed) {
      setError('Name is required')
      return
    }
    try {
      parseCustomAppearanceJson(draft)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return
    }
    onSave(trimmed, draft, asCopy)
  }
  // ...render as before, plus the name input and footer buttons below
}
```

Header title becomes `{theme ? 'Edit Theme' : 'New Theme'}`. Add above the textarea:

```tsx
          <div className="flex items-center gap-3 px-4 pt-4">
            <label className="text-[11px] uppercase tracking-wider text-muted">Name</label>
            <Input
              autoFocus
              value={name}
              maxLength={SAVED_THEME_NAME_MAX}
              onChange={event => {
                setName(event.target.value)
                setError(null)
              }}
              placeholder="Nord Night"
              className="max-w-xs"
            />
          </div>
```

Move `autoFocus` off the textarea onto the name input — for a new theme the name is the empty field, and for an edit it is still the field most likely to change. Footer:

```tsx
          <div className="flex items-center gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
            {theme ? (
              <Button type="button" variant="secondary" onClick={() => save(true)}>
                Save a copy
              </Button>
            ) : null}
            <Button type="button" onClick={() => save(false)}>Save &amp; apply</Button>
          </div>
```

- [ ] **Step 5: Type-check**

Run: `npx tsc -p tsconfig.web.json --noEmit 2>&1 | grep -v TS6305`
Expected: only the pre-existing `catalogCoverage.ts` / `committed.ts` errors that also fail on `main`.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/features/settings/ui/SettingsPage.tsx
git commit -m "feat(themes): name, create, duplicate, and edit saved themes"
```

---

### Task 7: Surface saved themes in the compact appearance menu

**Files:**
- Modify: `src/renderer/src/features/feed/AppearanceMenu.tsx:6-12` and its mode list

- [ ] **Step 1: Replace the stale exclusion comment**

The current comment says custom is excluded because it "is not a one-click preset," "needs the JSON editor in full Settings," and "the default custom payload starts as the dark theme." All three cease to be true once themes are named and saved. Replace it — do not merely delete it, or the next reader will wonder whether the omission was deliberate:

```tsx
// Saved themes DO appear here, unlike the old 'custom' sentinel. That entry
// was excluded because selecting it opened a JSON editor and looked like a
// broken no-op in a compact popover. A named saved theme is an ordinary
// one-click preset, so excluding it would just make the header menu disagree
// with Settings about what themes exist. Creating and editing still live in
// Settings — this popover only selects.
```

- [ ] **Step 2: Render built-ins then saved themes**

Map `THEME_MODES` as today, then append `settings.savedThemes.map(...)` using `theme.name` as the label and `theme.id` as the value. Selection is the same `onChange({ mode })` call — no editor entry point here.

- [ ] **Step 3: Verify in the running app**

Run: `npm run dev`
Then: create a theme in Settings, close Settings, open the header eye-icon popover.
Expected: the new theme is listed and selecting it re-themes the app immediately.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/features/feed/AppearanceMenu.tsx
git commit -m "feat(themes): list saved themes in the compact appearance menu"
```

---

### Task 8: End-to-end verification and PR

**Files:** none modified unless verification finds a defect.

- [ ] **Step 1: Type-check both projects, clean**

```bash
npx tsc -p tsconfig.node.json --noEmit
npx tsc -p tsconfig.web.json --noEmit
```
Expected: only the `catalogCoverage.ts` / `committed.ts` errors that also fail on `main`. Anything else is yours — fix it.

- [ ] **Step 2: Drive the app against the spec's success criteria**

Run `npm run dev`, then walk every case. Each maps to a spec success criterion:

1. Settings → Appearance → `+ New theme…`. The JSON is pre-filled with the current theme's values, not a blank object. Name it, change `"accent"`, Save & apply. The accent changes immediately, with no reload.
2. Create a second theme. Switch between it, the first, and Tokyonight. **Watch for stale inline properties** — a built-in that renders with leftover custom colors means the `clearCustomAppearance` path is not running.
3. Edit a theme's name and one color; restart the app; both persist.
4. Open a theme, Save a copy; the original is unchanged and a second entry appears.
5. Delete the active theme; the app falls back to Dark cleanly, with no broken intermediate render.
6. **Migration:** in DevTools, set the persisted blob back to a v4 shape and reload:
   ```js
   const k = Object.keys(localStorage).find(x => x.endsWith(':app-store'))
   const v = JSON.parse(localStorage[k])
   v.version = 4
   v.state.settings.mode = 'custom'
   delete v.state.settings.savedThemes
   localStorage[k] = JSON.stringify(v)
   location.reload()
   ```
   Expected: a theme named "Custom" exists, is selected, and renders the same colors as before the reload.
7. Delete a theme, then hand-edit `settings.mode` in localStorage to that dead id and reload. Expected: Dark, no crash, no blank screen.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/named-custom-themes
gh pr create --base main \
  --title "feat(themes): named custom color schemes" \
  --body "Closes #566 ..."
```

The PR body must state which success criteria were verified by driving the app and which were not, and must repeat that pre-existing `main` type errors are excluded. **Do not merge** — open the PR and stop.

---

## Self-Review

**Spec coverage.** Data model → Task 1/2. Resolution → Task 3. DOM seeding → Task 1 (`readAppliedAppearance`) + Task 6 (seeding the draft). Flat picker grid + inline Edit/Delete + `+ New theme…` → Task 5. Editor with name field and Save-a-copy → Task 6. Deletion with fallback → Task 6 Step 2. Persistence/migration/coercion ordering → Task 4. IPC → no work needed; verified by Task 8 only insofar as the desktop app is concerned. `AppearanceMenu` → Task 7. Risk 1 (`isDarkThemeMode`) → Task 2 Step 2. Risk 3 (coercion order) → Task 4 Step 1's WHY. Risk 4 (Monaco refcount) → no new `setTheme` call is introduced, so nothing to do.

**Known gap, accepted:** the phone client's rendering of a saved theme is not driven in Task 8, because pairing a phone is a heavier setup than this feature warrants. It is covered by construction — resolution is a pure function of `Settings`, which already crosses IPC opaquely — and `resolveThemePayload` is exported from the same module the phone client already imports `applyTheme` from.

**Type consistency.** `resolveThemePayload` returns `CustomAppearanceColors | null` in Tasks 3 and 5. `openThemeEditor(themeId: string | null)` is declared in Task 5 Step 2 and called with `null`/`theme.id` in Tasks 5 and 6. `createSavedTheme(name, json)` is defined in Task 1 and called in Tasks 4 and 6. `onSave(name, json, asCopy)` matches between Task 6 Steps 3 and 4.
