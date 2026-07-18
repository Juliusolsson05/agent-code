# Named Custom Themes — Design

**Date:** 2026-07-18
**Branch:** `feat/named-custom-themes`
**Status:** Design approved, ready for implementation planning

## Problem

Agent Code ships five built-in themes and exactly **one** custom slot. `Settings.customAppearanceJson` is a single raw JSON string; `mode: 'custom'` applies it. There is no way to keep two custom themes, no way to name one, no way to switch between them, and no way to get a theme in or out of the app except by copy-pasting out of a textarea.

The user wants: configure a color scheme, **save it with a name**, **pick it** in Settings, and **edit** or **delete** it later.

## What exists today (verified, with file references)

Understanding the current system is most of the design work, because the runtime half already does everything we need.

### Token vocabulary

`CUSTOM_APPEARANCE_COLOR_KEYS` (`src/renderer/src/app-state/settings/customAppearance.ts:1-83`) is the canonical list of **81 semantic color tokens**. Each key maps 1:1 to a CSS variable via `CUSTOM_APPEARANCE_CSS_VARS` (camelCase `rowSelectedBg` → `--theme-row-selected-bg` → Tailwind `bg-row-selected-bg`), carries a human-readable purpose in `CUSTOM_APPEARANCE_COLOR_DESCRIPTIONS`, and appears in the generated `CUSTOM_APPEARANCE_SCHEMA` (`additionalProperties: false`, all keys optional).

Groups: materials (8), accent/focus (4), panel (4), row/list (5), control (7), input (4), tab (4), popover/overlay (5), code slab (8), full editor (8), status families (16), feed-specific (8).

**This feature does not add, remove, or rename a single token.** The token vocabulary is out of scope.

### Runtime application

`applyTheme(settings)` (`src/renderer/src/app-state/settings/theme.ts:42-75`) is the single write point to the DOM:

1. Sets `<html data-mode>` and `<html data-contrast>`, selecting a static CSS block in `styles.css`.
2. For custom mode, writes all 81 tokens as **inline custom properties** on `<html>`; otherwise clears all 81 and writes only the accent pair.
3. Writes font variables.
4. Dispatches the `theme-changed` window event, which xterm and Monaco consumers use to re-read `getComputedStyle`.

It is fully live — no reload, no React re-render for DOM surfaces.

**The critical property for this design:** `applyTheme` does not care *where* the color payload came from. Named themes change which payload is selected, not how it is applied. The runtime layer needs one small change (resolving a theme id to a payload) and nothing else.

The teardown at `theme.ts:97-100` is load-bearing: inline styles beat every `[data-mode]` rule, so leaving custom mode **must** clear all 81 properties or built-in themes render broken until reload. Any new code path that switches themes inherits this obligation.

### Persistence

Zustand `persist` into localStorage, key `${APP_LOCAL_STORAGE_PREFIX}:app-store`, `partialize` to `{ settings }`, currently **version 4** (`src/renderer/src/app-state/store.ts`). `coerceSettings` (`app-state/settings/persistence.ts:19-99`) runs in both `merge` and `migrate` and membership-checks `mode` against `THEME_MODES`.

`store.ts:23-35` carries an explicit scar comment: #249 added a persisted field without bumping the version, existing users skipped coercion, and the command registry dereferenced `undefined[id]` → **black screen on launch**. This design bumps the version.

### Validation

`parseCustomAppearanceJson()` (`customAppearance.ts:371-417`) rejects non-objects, arrays, unknown keys, non-string values, and unsafe colors. `isSafeCssColorValue()` (`428-446`) caps length at 180, forbids `;{}`, requires balanced parens, and rejects `url()`, `image()`, `image-set()`, `cross-fade()`, `element()`, `paint()`, and `var()` — the WHY notes that several tokens are consumed by `background` shorthand, where `url(...)` is valid and can trigger a network fetch from a local-only setting.

Missing keys are backfilled from `DEFAULT_CUSTOM_APPEARANCE` rather than failing, because new product tokens get added over time and a fatal schema error would throw away a user's saved theme during coercion. **Both halves of that policy carry forward unchanged.**

### Settings UI

- `features/settings/lib/settingsRegistry.ts:226-244` — `theme-mode`, a 2-column select over `THEME_MODES`. Selecting `custom` does *not* set the mode; it calls `ctx.openCustomAppearanceEditor()`.
- `features/settings/ui/SettingsPage.tsx:122-211` — `CustomAppearanceModal`, a plain textarea JSON editor with a `json`/`schema` toggle and a save-time parse error line.
- `features/feed/AppearanceMenu.tsx` — compact header popover, deliberately excludes custom.

### Constraints inherited from the current design

1. **`custom` is a fake entry in the mode list.** It renders as a picker cell but acts as a button. `types.ts:23-27` documents that it sits at index 5 to make the Appearance grid an even 3×2.
2. **Built-in palettes are unreachable from TypeScript.** `THEME_MODES` carries only `{id, label, family}`; the hexes live in CSS-only `[data-mode]` blocks. `DEFAULT_CUSTOM_APPEARANCE` is a hardcoded copy of the dark palette that can silently drift from `styles.css`.
3. **Custom mode ignores accent and high contrast.** `applyTheme` branches away from the accent path, and `[data-contrast="high"]` selectors never list `[data-mode="custom"]`.
4. **`isDarkThemeMode()` treats anything not in the `light` family as dark**, so custom counts as dark for accent resolution. xterm sniffs actual luminance instead.

## Design

### Data model

```ts
// app-state/settings/savedThemes.ts (new file)

export type SavedTheme = {
  id: string            // `theme:${uuid}` — also the value stored in Settings.mode
  name: string          // user-facing, 1..48 chars after trim
  json: string          // raw JSON text, exactly as the user typed it
  createdAt: number
  updatedAt: number
}
```

Settings gains one field and widens one:

```ts
type Settings = {
  mode: ThemeModeId | SavedThemeId   // was: ThemeModeId
  savedThemes: SavedTheme[]          // new
  customAppearanceJson: string       // RETAINED — see migration
  // ...unchanged
}
```

**WHY `json` is a raw string, not a parsed object.** This preserves the existing documented rationale: the editor is a JSON text editor, and users expect formatting, key ordering, and their own arrangement to survive a round trip. Storing parsed objects would silently reformat every theme on every save. Validation still happens — at save time (blocks the save) and at load time (coercion drops invalid entries).

**WHY the id is the mode value.** `Settings.mode` becomes `'dark' | 'light' | ... | 'theme:<uuid>'`. One field still answers "what am I looking at," so `applyTheme`, the remote phone client, and `useThemeSync` keep a single input. The alternative — a separate `activeSavedThemeId` field — creates two sources of truth and an invalid state where `mode !== 'custom'` but a theme id is set.

**WHY an array, not a keyed record.** Display order is user-visible in the picker grid. An array preserves insertion order without a separate ordering field.

### Resolution

One new pure function, the seam between "which theme" and "what colors":

```ts
// Returns the 81-token payload to apply, or null for built-in modes.
resolveThemePayload(settings: Settings): CustomAppearance | null
```

- Built-in mode id → `null` (existing accent path runs unchanged).
- `theme:<uuid>` present in `savedThemes` → parse its `json`, backfill missing keys from `DEFAULT_CUSTOM_APPEARANCE`.
- `theme:<uuid>` **not** found (deleted, or synced from another machine) → fall back to `dark` and return `null`.
- Legacy `'custom'` → parse `customAppearanceJson` (transitional; see migration).

`applyTheme` calls this instead of branching on `mode === 'custom'` directly. The clear-all-81-properties teardown at `theme.ts:97-100` now triggers whenever the payload is `null`, which covers both "switched to a built-in" and "the referenced theme was deleted."

### Creation seeds from the live DOM

`+ New theme…` does **not** open a blank object. It reads the 81 currently-applied values off `<html>` with `getComputedStyle` and pre-fills the editor with them.

**WHY.** Two reasons, one practical and one structural.

Practical: a blank or sparse starting object renders as an unreadable mess the moment it is applied, because the user is now editing a theme that shares almost nothing with what they were just looking at. Seeding from the current theme means the first save always looks like "the theme I had, plus my one change."

Structural: this is the only way to get built-in palette values into TypeScript. The hexes exist solely in CSS `[data-mode]` blocks. `getComputedStyle` after application is the same mechanism `readXtermTheme()` and the Monaco theme bridges already use (`workspace/tile-tree/xtermTheme.ts`), so this is an established pattern in the codebase, not a new one. It gives us "duplicate Tokyonight and tweak it" without duplicating the palettes into TS, and without the drift risk that `DEFAULT_CUSTOM_APPEARANCE` already demonstrates.

Consequence: a seeded theme is dense (all 81 keys), not sparse. That is acceptable — `DEFAULT_CUSTOM_APPEARANCE` is already a dense object, and the sparse-override capability remains available to anyone hand-writing JSON.

### Settings UI

The picker becomes a flat grid: built-ins, then saved themes, then a trailing `+ New theme…` cell.

```
Theme
┌────────────────────────────┬────────────────────────────┐
│ ▪ Dark                     │   Gray Dark                │
├────────────────────────────┼────────────────────────────┤
│   Tokyonight               │   Light                    │
├────────────────────────────┼────────────────────────────┤
│   Soft Light               │   Nord Night        CUSTOM │
├────────────────────────────┼────────────────────────────┤
│   Paper Warm        CUSTOM │   + New theme…             │
└────────────────────────────┴────────────────────────────┘
```

Hovering a saved-theme cell replaces the `CUSTOM` tag with inline actions:

```
│   Nord Night   [Edit] [Delete] │
```

**WHY flat rather than a separate "My Themes" section.** A saved theme *is* a theme; segregating user content into a second-class list below the "real" options discourages use. There is direct precedent in this codebase: the prompt-template palette lists custom templates in the same list as built-ins, tagged with `scope` and carrying inline Edit/Delete buttons (`features/command-palette/ui/CommandPalette.tsx:1462-1507`). Matching that shape gives one mental model for "built-in vs. mine" across the app.

**Consequence for the 3×2 grid comment.** `types.ts:23-27` explains that `custom` sits at index 5 to make the grid an even 3×2. That arrangement dies here: the `custom` sentinel leaves `THEME_MODES` entirely, and the grid length now varies with theme count. The `+ New theme…` cell always occupies the last slot, so the grid stays a filled rectangle for even counts and has one gap for odd counts. **The stale comment must be deleted in the same commit** — leaving it would send future-me hunting for a constraint that no longer exists.

### Editor modal

`CustomAppearanceModal` grows a **Name** field above the existing textarea and keeps everything else — the `json`/`schema` toggle, the read-only schema `<pre>`, the inline parse-error line.

```
┌─ Edit Theme ─────────────────────────────────────────────────┐
│                                                              │
│  Name  ┌────────────────────────────────────────────────┐    │
│        │ Nord Night                                     │    │
│        └────────────────────────────────────────────────┘    │
│                                            [ json │ schema ] │
│  ┌────────────────────────────────────────────────────────┐  │
│  │ {                                                      │  │
│  │   "canvas": "#1a1b26",                                 │  │
│  │   "surface": "#1f2335",                                │  │
│  │   "ink": "#c0caf5",                                    │  │
│  │   "accent": "#7aa2f7"                                  │  │
│  │ }                                                      │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ✕ unknown key "surfacce"                                    │
│                                                              │
│              [ Cancel ]  [ Save a copy ]  [ Save & apply ]   │
└──────────────────────────────────────────────────────────────┘
```

- **Save & apply** — writes the theme and switches `mode` to it. Matches today's behavior, where saving custom appearance also selects it.
- **Save a copy** — writes a new theme with a new id, leaves the original untouched. This is the duplicate path: open an existing theme, tweak, save a copy.
- **Cancel** — discards. No autosave.

Validation is unchanged and save-time only: `parseCustomAppearanceJson()` gates the save, and a blank name blocks it. Name uniqueness is **not** enforced — ids are unique, names are labels, and refusing a duplicate name is a papercut with no correctness payoff.

### Deletion

Delete removes the theme from `savedThemes`. If it was the active theme, `mode` falls back to `dark` and the 81 inline properties are cleared by the existing teardown path.

**No confirmation dialog.** The codebase's prompt-template delete has none either, and a theme is cheap to recreate. If this proves wrong, a confirm is a one-line addition later.

### Persistence and migration

Bump `store.ts` version **4 → 5**. The migration:

1. If `mode === 'custom'` and `customAppearanceJson` parses, create a `SavedTheme` named `"Custom"` holding that JSON and set `mode` to its id. The user keeps looking at exactly what they were looking at.
2. If `mode === 'custom'` but the JSON is invalid, fall back to `dark` — matching today's `coerceCustomAppearanceJson` behavior, which silently substitutes the default on parse failure.
3. Otherwise leave `mode` alone.

`coerceSettings` gains: `savedThemes` array coercion (drop non-objects, entries missing `id`/`name`/`json`, entries whose `json` fails `parseCustomAppearanceJson`, and duplicate ids — mirroring `normalizeCustomTemplates`), and a widened `mode` check that accepts a built-in id **or** an id present in the coerced `savedThemes`, falling back to `dark` otherwise.

**Ordering matters:** `savedThemes` must be coerced *before* `mode` is validated, since `mode` validity depends on the surviving themes. This is the one sequencing bug most likely to be introduced by a careless implementation.

`customAppearanceJson` is **retained in the type and in `DEFAULT_SETTINGS`**, not deleted. A user who downgrades, or whose migration is somehow skipped, still has their original payload sitting there. It becomes vestigial after migration; removing it is a separate cleanup once v5 has been in the wild.

### IPC and the phone client

`useThemeSync` already ships the whole `Settings` object to main via `remoteSetThemeSettings`, main relays it opaquely (`RemoteController.ts:251-259` documents that main deliberately does not interpret these fields), and the phone client merges into `DEFAULT_SETTINGS` and calls the same `applyTheme`.

Because `savedThemes` rides inside `Settings` and resolution is a pure function of `Settings`, **the phone client gets named themes for free** — provided `resolveThemePayload` lives somewhere both bundles import, alongside the existing shared `applyTheme`. No IPC changes.

### Out of scope

Deliberately excluded to keep this shippable:

- **Import/export to file, or clipboard commands.** Real gap, separate feature. The textarea remains the transfer mechanism.
- **Color-picker / swatch UI.** The JSON editor stays. Per-token pickers over 81 tokens is its own project.
- **Live preview while typing.** Save-time application only.
- **Making custom themes honor accent and high contrast.** Pre-existing limitation, unchanged by this work, and entangled with how the `[data-contrast]` selectors are written.
- **System theme following.** Nothing reads `prefers-color-scheme` today.
- **A test asserting key-set parity** between `CUSTOM_APPEARANCE_COLOR_KEYS` and the `@theme inline` bindings. Real gap, but a test-suite change, and this repo's convention is not to add test files in feature PRs.

## Files touched

**New**
- `src/renderer/src/app-state/settings/savedThemes.ts` — `SavedTheme` type, id minting, CRUD helpers, `coerceSavedThemes`, `resolveThemePayload`, `readAppliedAppearance()` (the `getComputedStyle` seeder).

**Modified**
- `app-state/settings/types.ts` — widen `mode`, add `savedThemes`, drop the `custom` sentinel from `THEME_MODES`, **delete the stale 3×2 grid comment**, extend `isDarkThemeMode` to resolve saved themes by luminance rather than assuming dark.
- `app-state/settings/theme.ts` — `applyTheme` calls `resolveThemePayload`.
- `app-state/settings/persistence.ts` — coerce `savedThemes`, then widen the `mode` check.
- `app-state/store.ts` — version 4 → 5, migration.
- `features/settings/lib/settingsRegistry.ts` — theme-mode select renders built-ins + saved + `+ New theme…`; wire edit/delete.
- `features/settings/ui/SettingsPage.tsx` — name field, three-button footer, create/edit/duplicate/delete handlers.
- `features/feed/AppearanceMenu.tsx` — decide whether saved themes appear in the compact popover. **They should**, since the original exclusion reasoned that custom "is not a one-click preset" and "the default custom payload starts as the dark theme" — both cease to be true once themes are named, saved, and one-click. The stale WHY comment gets replaced, not just deleted.

## Risks

1. **`isDarkThemeMode` for saved themes.** Today it returns `true` for anything not in the `light` family, so a user's light custom theme is treated as dark for accent resolution. With named themes this becomes more visible. Mitigation: resolve a saved theme's `canvas` luminance, reusing the approach `xtermTheme.ts` already takes. If that proves noisy, the fallback is an explicit `family: 'light' | 'dark'` field on `SavedTheme` set at save time.
2. **Migration correctness.** The #249 black-screen precedent is the worst case. Mitigation: the version bump, plus `coerceSettings` being defensive enough that a malformed `savedThemes` degrades to an empty array rather than throwing.
3. **Coercion ordering.** `mode` validation depends on coerced `savedThemes`. Called out above; needs a WHY comment at the call site.
4. **Monaco theme refcount.** `lib/code/monacoThemeState.ts` documents the #513 "theme war" — Monaco's `setTheme` is process-global and code slabs fought the file editor. This design does not change how Monaco consumes themes (it still reacts to the `theme-changed` event), but any implementation that adds a new `setTheme` call must honor `isEditorThemeActive()`.

## Success criteria

- Create a theme from the current one, name it, save it; it appears in the picker and applies immediately with no reload.
- Switch between two saved themes and a built-in; no stale inline properties leak between them.
- Edit a saved theme's name and colors; changes persist across an app restart.
- Delete the active theme; the app falls back to Dark without a broken intermediate render.
- An existing user on `mode: 'custom'` upgrades and sees their theme intact under the name "Custom".
- A paired phone client reflects the active saved theme without IPC changes.
