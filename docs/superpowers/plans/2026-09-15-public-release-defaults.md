# Public-Release Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Agent Code with Nord as the default theme, Dispatch (global scope) as the default view, and the owner's day-to-day preferences as the public defaults, with no green left in any default.

**Architecture:** Built-in themes are CSS `[data-mode]` blocks in `src/renderer/src/styles.css`; the accent is a separate `ACCENTS` table written inline on `<html>` by `applyTheme`; every default lives in `DEFAULT_SETTINGS` and is re-applied to persisted blobs by `coerceSettings`. This plan adds one mode block pair (`dark-nord`), one accent (`frost`), flips the defaults table, teaches `coerceSettings` the new absent-key semantics, and migrates blobs that sit on exactly the old default appearance. Nothing else changes shape.

**Tech Stack:** TypeScript, React, Zustand persist, Tailwind v4 `@theme inline`, vitest (renderer tests run under happy-dom; the project's `.nvmrc` is Node 24 and Node 25 breaks happy-dom).

**Spec:** GitHub issue #973 (`feat(defaults): ship Nord theme, global Dispatch and public-release defaults`). The design was agreed in chat on 2026-09-15; the issue body is the written record.

## Global Constraints

- Node 24 for every test run (`export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH"`).
- Verification is raw `npx tsc -b` on both projects (electron-vite build and vitest do not type-check). Never `--noEmit` on the node project.
- Explicitly persisted values are never overridden by a default flip. The one deliberate exception is the Dark + Lime → Nord + Frost migration, and only for that exact pair.
- Thick WHY comments at every decision point. No `.md` documentation beyond this plan.
- No new CI locks, no scaffolding. API + tests + comments and stop.
- Do not run the full test suite between tasks. Run the named test files per task; run `tsc -b` and the touched suites once at the end.
- Nord palette (source of truth is the owner's JSON, reproduced here in lowercase):

| token | value |
|---|---|
| canvas / codeBg / editorBg / inputBg / tabBg / accentFg / dangerFg / successFg / warningFg / infoFg | `#171b21` |
| surface / panelBg / panelHeaderBg / tabActiveBg / popoverBg | `#20242d` |
| surfaceHi / border / panelElevatedBg / controlBg / tabHoverBg | `#262b35` |
| panelBorder / codeBorder | `#2e3440` |
| borderHi / controlBorder / inputBorder / popoverBorder | `#3b4252` |
| controlBorderHover | `#4c566a` |
| ink / editorFg / codeInk / controlFg | `#d8dee9` |
| inkDim | `rgba(216, 222, 233, 0.68)` |
| muted / codeInkDim | `rgba(216, 222, 233, 0.42)` |
| inputPlaceholder | `rgba(216, 222, 233, 0.35)` |
| accent / focusRing / controlActiveBg / inputBorderFocus / tabAccent | `#88c0d0` |
| accentSoft | `rgba(136, 192, 208, 0.14)` |
| rowSelectedBg | `rgba(136, 192, 208, 0.16)` |
| rowSelectedFg | `#eceff4` |
| rowHoverBg | `rgba(46, 52, 64, 0.75)` |
| rowDangerSelectedBg | `rgba(191, 97, 106, 0.20)` |
| controlHoverBg | `#2e3440` |
| overlayScrim | `rgba(13, 14, 18, 0.65)` |
| overlayScrimStrong | `rgba(13, 14, 18, 0.85)` |
| shadowColor | `rgba(13, 14, 18, 0.75)` |
| codeCurrentLineBg | `rgba(46, 52, 64, 0.70)` |
| codeSelectionBg | `rgba(136, 192, 208, 0.22)` |
| codeSelectionInactiveBg / editorSelectionInactiveBg | `rgba(59, 66, 82, 0.55)` |
| codeScrollbarBg / editorScrollbarBg | `rgba(76, 86, 106, 0.45)` |
| codeScrollbarHoverBg / editorScrollbarHoverBg | `rgba(94, 129, 172, 0.60)` |
| codeScrollbarActiveBg / editorScrollbarActiveBg | `#5e81ac` |
| editorCurrentLineBg | `rgba(46, 52, 64, 0.60)` |
| editorSelectionBg | `rgba(136, 192, 208, 0.20)` |
| danger / diffRemoveFg | `#bf616a` |
| dangerSoft | `rgba(191, 97, 106, 0.15)` |
| dangerBorder | `rgba(191, 97, 106, 0.45)` |
| success / diffAddFg | `#a3be8c` |
| successSoft | `rgba(163, 190, 140, 0.15)` |
| successBorder | `rgba(163, 190, 140, 0.45)` |
| warning | `#ebcb8b` |
| warningSoft | `rgba(235, 203, 139, 0.15)` |
| warningBorder | `rgba(235, 203, 139, 0.45)` |
| info | `#81a1c1` |
| infoSoft | `rgba(129, 161, 193, 0.15)` |
| infoBorder | `rgba(129, 161, 193, 0.45)` |
| userBg | `rgba(94, 129, 172, 0.12)` |
| toolBg | `rgba(46, 52, 64, 0.55)` |
| diffAddBg | `rgba(163, 190, 140, 0.13)` |
| diffRemoveBg | `rgba(191, 97, 106, 0.13)` |
| rowBg | `transparent` |

- Flattened Nord values for hex-only consumers (alpha token composited over `#171b21`): inkDim → `#9aa0a9`, muted → `#686d75`.

---

## File map

| File | Responsibility in this change |
|---|---|
| `src/renderer/src/app-state/settings/types.ts` | `ThemeMode` + `THEME_MODES` gain `dark-nord`; `AccentId` + `ACCENTS` gain `frost` and lose `lime`/`sage`; `DEFAULT_SETTINGS` flips. |
| `src/renderer/src/styles.css` | Nord base block shared with `:root`; legacy Dark gets its own block; Nord semantic override block; light accent; high-contrast selector list. |
| `src/renderer/src/app-state/settings/customAppearance.ts` | `DEFAULT_CUSTOM_APPEARANCE` becomes Nord; comment wording. |
| `src/renderer/src/app-state/settings/persistence.ts` | Dark+Lime migration; absent-key semantics for flipped defaults; retired keys. |
| `src/renderer/src/app-state/store.ts` | Persist version 11 + comment. |
| `src/renderer/src/lib/hotkeyBinding.ts` | `DEFAULT_DICTATION_HOTKEY` becomes `'Fn'`. |
| `src/renderer/src/workspace/hook/persistence/useBootstrap.ts` | Fresh install enters Dispatch with global scope. |
| `src/renderer/src/workspace/hook/actions/dispatch.ts` | Two `?? 'project'` fallbacks become `?? 'global'`. |
| `src/renderer/src/workspace/tile-tree/xtermTheme.ts` | rgba-aware `colorWithAlpha`; Nord fallbacks. |
| `src/renderer/src/lib/code/monacoRuntime.ts`, `src/renderer/src/features/editor/lib/monacoEditorTheme.ts` | Nord fallback literals. |
| `src/remote-client/src/styles.css` | Nord fallback literals. |
| `src/main/window/appWindow.ts` | Window `backgroundColor` is the Nord canvas. |
| `src/renderer/src/features/system-perf/ui/SystemPerfBadge.tsx`, `SystemPerfPopover.tsx` | Chart strokes read theme tokens. |
| `src/renderer/src/features/settings/ui/ThemePickerRow.tsx`, `src/renderer/src/features/settings/lib/settingsRegistry.ts`, `src/renderer/src/app-state/settings/theme.ts`, `savedThemes.ts` comments | "Dark" as the fallback name becomes "Nord"; `nord` search keyword. |
| `src/renderer/src/features/workspace/commands/sessionCommands.ts`, `src/renderer/src/features/copy-code-block/commands/copyCodeBlockCommands.ts`, `src/renderer/src/features/copy-assistant/commands/copyAssistantCommands.ts` | Eight commands leave the `advanced` tier. |
| Tests | `theme.renderer.test.ts`, new `nordTheme.test.ts`, `persistence.test.ts`, new `xtermTheme.test.ts`, `taxonomy.test.ts`. |

---

### Task 1: Nord mode, Frost accent, and the default appearance

**Files:**
- Modify: `src/renderer/src/app-state/settings/types.ts` (ThemeMode union, THEME_MODES, AccentId, ACCENTS, DEFAULT_SETTINGS.mode/accent)
- Modify: `src/renderer/src/styles.css` (mode blocks)
- Modify: `src/renderer/src/features/settings/lib/settingsRegistry.ts:467` (keywords)
- Modify: `src/renderer/src/features/settings/ui/ThemePickerRow.tsx:129` (fallback wording)
- Test: `src/renderer/src/app-state/settings/theme.renderer.test.ts`
- Test (new): `src/renderer/src/app-state/settings/nordTheme.test.ts`

**Interfaces:**
- Produces: `ThemeMode` includes `'dark-nord'`; `AccentId` is `'frost' | 'amber' | 'sky' | 'magenta' | 'gold' | 'coral' | 'lavender'`; `DEFAULT_SETTINGS.mode === 'dark-nord'`, `DEFAULT_SETTINGS.accent === 'frost'`; `ACCENTS[0].id === 'frost'`.

- [ ] **Step 1: Write the failing applyTheme test**

Append to `theme.renderer.test.ts`:

```ts
describe('applyTheme default appearance', () => {
  // The public-release contract (#973): a fresh install paints Nord with the
  // Frost accent, and nothing green. This asserts the values applyTheme writes
  // rather than DEFAULT_SETTINGS itself, because the accent reaches the DOM
  // through the ACCENTS table — a default id that resolves to no entry would
  // silently fall back to ACCENTS[0], and that is the failure this catches.
  it('paints Nord with the Frost accent for the shipped defaults', () => {
    applyTheme(DEFAULT_SETTINGS)
    const root = document.documentElement
    expect(root.dataset.mode).toBe('dark-nord')
    expect(root.style.getPropertyValue('--theme-accent')).toBe('#88c0d0')
    expect(root.style.getPropertyValue('--theme-accent-fg')).toBe('#171b21')
  })

  it('uses the darker Frost pair on light themes', () => {
    applyTheme({ ...DEFAULT_SETTINGS, mode: 'light' })
    expect(document.documentElement.style.getPropertyValue('--theme-accent')).toBe('#5e81ac')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/renderer/src/app-state/settings/theme.renderer.test.ts`
Expected: FAIL — `data-mode` is `dark`, accent is `#7dd3a0`.

- [ ] **Step 3: Update the theme model in types.ts**

Replace the `ThemeMode` union, `THEME_MODES`, `AccentId`, `ACCENTS`, and the two defaults:

```ts
export type ThemeMode =
  | 'dark-nord'
  | 'dark'
  | 'dark-dim'
  | 'dark-tokyonight'
  | 'light'
  | 'light-soft'

export const THEME_MODES: ThemeModeMeta[] = [
  // Nord is first because it is the default: the picker grid reads top-left
  // as "what the app ships with", and the previous first entry was also the
  // previous default. Its palette lives in styles.css like every built-in.
  { id: 'dark-nord', label: 'Nord', family: 'dark' },
  { id: 'dark', label: 'Dark', family: 'dark' },
  { id: 'dark-dim', label: 'Gray Dark', family: 'dark' },
  { id: 'dark-tokyonight', label: 'Tokyonight', family: 'dark' },
  { id: 'light', label: 'Light', family: 'light' },
  { id: 'light-soft', label: 'Soft Light', family: 'light' },
]

export type AccentId =
  | 'frost'
  | 'amber'
  | 'sky'
  | 'magenta'
  | 'gold'
  | 'coral'
  | 'lavender'

// WHY Lime and Sage are gone rather than merely demoted: the public-release
// audit (#973) asked for no green in any default, and the green accents WERE
// the old identity — every marker, dot and focus ring wore Lime. Leaving them
// selectable would keep two entries whose only purpose was the look we are
// replacing. coerceSettings maps a persisted 'lime'/'sage' to Frost, so an
// existing install lands on the new default rather than on garbage.
//
// Frost is Nord's `nord8` (#88c0d0) on dark canvases and `nord10` (#5e81ac)
// on the cream light canvases, where nord8 has too little contrast to carry
// focus rings.
export const ACCENTS: AccentMeta[] = [
  { id: 'frost', name: 'Frost', dark: '#88c0d0', light: '#5e81ac', fgDark: '#171b21', fgLight: '#faf9f6' },
  { id: 'amber', name: 'Amber', dark: '#ff9f4a', light: '#8a470b', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'sky', name: 'Sky', dark: '#6bb6ff', light: '#1f5eaa', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'magenta', name: 'Magenta', dark: '#e66ed9', light: '#8b247f', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'gold', name: 'Gold', dark: '#f5d64a', light: '#735905', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'coral', name: 'Coral', dark: '#ff6b6b', light: '#9f2929', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
  { id: 'lavender', name: 'Lavender', dark: '#b5a3ff', light: '#5a43b4', fgDark: '#0a0a0a', fgLight: '#faf9f6' },
]
```

In `DEFAULT_SETTINGS`:

```ts
  // Nord + Frost are the public-release look (#973). The old Dark + Lime pair
  // is still selectable; installs sitting on exactly that pair are migrated
  // by coerceSettings so "the default changed" reaches existing users too.
  mode: 'dark-nord',
  ...
  accent: 'frost',
```

- [ ] **Step 4: Add the Nord CSS blocks**

In `styles.css`, replace the `/* ---------- Mode: Dark (default) ---------- */` block header and selector so the shared base block is Nord, and give Dark its own block immediately after it:

```css
/* ---------- Mode: Nord (default) ----------
 * `:root` shares this block on purpose: it is the palette painted before the
 * first applyTheme run and the palette any unknown data-mode value degrades
 * to, and both of those must be the DEFAULT theme or a fresh install flashes
 * a different look for one frame. The previous default (Dark) used to sit
 * here for the same reason; it moved to its own block below when Nord took
 * over (#973). Accent-derived tokens keep using var(--theme-accent) so the
 * accent picker works on Nord exactly as on every other built-in. */

:root,
[data-mode="dark-nord"] {
  --theme-canvas: #171b21;
  --theme-surface: #20242d;
  --theme-surface-hi: #262b35;
  --theme-ink: #d8dee9;
  --theme-ink-dim: rgba(216, 222, 233, 0.68);
  --theme-muted: rgba(216, 222, 233, 0.42);
  --theme-border: #262b35;
  --theme-border-hi: #3b4252;

  /* Default accent — overridden at runtime via applyTheme() from ACCENTS. */
  --theme-accent: #88c0d0;
  --theme-accent-fg: #171b21;
  --theme-accent-soft: color-mix(in srgb, var(--theme-accent) 14%, transparent);

  /* Nord keeps the code slab on the canvas colour and lets the border carry
     the edge; the old palette sank the slab below the canvas instead. */
  --theme-code-bg: #171b21;
  --theme-code-border: #2e3440;
  --theme-danger: #bf616a;
  --theme-danger-fg: #171b21;
  --theme-danger-soft: color-mix(in srgb, var(--theme-danger) 15%, transparent);
  --theme-danger-border: color-mix(in srgb, var(--theme-danger) 45%, transparent);
  --theme-success: #a3be8c;
  --theme-success-fg: #171b21;
  --theme-success-soft: color-mix(in srgb, var(--theme-success) 15%, transparent);
  --theme-success-border: color-mix(in srgb, var(--theme-success) 45%, transparent);
  --theme-warning: #ebcb8b;
  --theme-warning-fg: #171b21;
  --theme-warning-soft: color-mix(in srgb, var(--theme-warning) 15%, transparent);
  --theme-warning-border: color-mix(in srgb, var(--theme-warning) 45%, transparent);
  --theme-info: #81a1c1;
  --theme-info-fg: #171b21;
  --theme-info-soft: color-mix(in srgb, var(--theme-info) 15%, transparent);
  --theme-info-border: color-mix(in srgb, var(--theme-info) 45%, transparent);

  --theme-code-ink: #d8dee9;
  --theme-code-ink-dim: rgba(216, 222, 233, 0.42);

  /* User turns take a frost-blue wash, tool output a polar-night wash, so the
     two read as different layers without either becoming a card. */
  --theme-user-bg: rgba(94, 129, 172, 0.12);
  --theme-tool-bg: rgba(46, 52, 64, 0.55);

  --theme-diff-add-bg: rgba(163, 190, 140, 0.13);
  --theme-diff-remove-bg: rgba(191, 97, 106, 0.13);
  --theme-diff-add-fg: #a3be8c;
  --theme-diff-remove-fg: #bf616a;

  /* --theme-app-font is set at runtime by applyTheme — see the note that
     used to live in the Dark block; it applies unchanged. */
}

/* ---------- Mode: Dark (legacy default) ---------- */

[data-mode="dark"] {
  ...every declaration the old `:root, [data-mode="dark"]` block carried,
  unchanged, with `--theme-accent: #88c0d0; --theme-accent-fg: #171b21;`
  in place of the Lime pair (the accent is written inline by applyTheme
  anyway; the static value only matters as the no-JS fallback and must not
  be green)...
}
```

Keep the long `--theme-app-font` comment with the Nord block (it is about `:root`, not about Dark).

Change the light block's static accent from `#3f7656` / `#faf9f6` to `#5e81ac` / `#faf9f6`.

Add `[data-contrast="high"][data-mode="dark-nord"],` as the first selector of the dark high-contrast block.

After the `/* ---------- Semantic Relationship Tokens ---------- */` `:root { … }` block, add:

```css
/* ---------- Nord semantic overrides ----------
 * WHY a second Nord block, and why the compound selector: the other built-in
 * modes restate only the primitive tokens and let the alias block above
 * derive every interaction state from them. Nord ships opaque controls, a
 * visible input border, its own scrim and shadow tints and its own scrollbar
 * blues, so it has to override aliases. A plain `[data-mode="dark-nord"]`
 * would tie with `:root` on specificity and lose to it on source order;
 * `:root[data-mode="dark-nord"]` wins on specificity wherever it sits, the
 * same trick the `[data-contrast][data-mode]` blocks rely on. Anything whose
 * Nord value equals the alias derivation (panel-bg = surface, focus ring =
 * accent, control-active = accent, editor-bg = canvas …) is deliberately not
 * restated. Accent-derived values keep var(--theme-accent) so the accent
 * picker still works on Nord. */
:root[data-mode="dark-nord"] {
  --theme-panel-border: #2e3440;

  --theme-row-hover-bg: rgba(46, 52, 64, 0.75);
  --theme-row-selected-bg: color-mix(in srgb, var(--theme-accent) 16%, transparent);
  --theme-row-selected-solid-bg: color-mix(in srgb, var(--theme-accent) 16%, var(--theme-surface));
  --theme-row-selected-fg: #eceff4;
  --theme-row-danger-selected-bg: color-mix(in srgb, var(--theme-danger) 20%, transparent);

  --theme-control-bg: #262b35;
  --theme-control-hover-bg: #2e3440;
  --theme-control-border: #3b4252;
  --theme-control-border-hover: #4c566a;
  --theme-control-fg: #d8dee9;

  --theme-input-bg: #171b21;
  --theme-input-border: #3b4252;
  --theme-input-placeholder: rgba(216, 222, 233, 0.35);

  --theme-tab-bg: #171b21;
  --theme-tab-active-bg: #20242d;
  --theme-tab-hover-bg: #262b35;

  --theme-popover-bg: #20242d;
  --theme-popover-border: #3b4252;
  --theme-overlay-scrim: rgba(13, 14, 18, 0.65);
  --theme-overlay-scrim-strong: rgba(13, 14, 18, 0.85);
  --theme-shadow-color: rgba(13, 14, 18, 0.75);

  --theme-code-current-line-bg: rgba(46, 52, 64, 0.70);
  --theme-code-selection-bg: color-mix(in srgb, var(--theme-accent) 22%, transparent);
  --theme-code-selection-inactive-bg: rgba(59, 66, 82, 0.55);
  --theme-code-scrollbar-bg: rgba(76, 86, 106, 0.45);
  --theme-code-scrollbar-hover-bg: rgba(94, 129, 172, 0.60);
  --theme-code-scrollbar-active-bg: #5e81ac;

  --theme-editor-current-line-bg: rgba(46, 52, 64, 0.60);
  --theme-editor-selection-inactive-bg: rgba(59, 66, 82, 0.55);
  --theme-editor-scrollbar-bg: rgba(76, 86, 106, 0.45);
  --theme-editor-scrollbar-hover-bg: rgba(94, 129, 172, 0.60);
  --theme-editor-scrollbar-active-bg: #5e81ac;
}
```

Also update the "Theme architecture" header comment's line about the accent (still true) — no change needed — and the `settingsRegistry.ts` `theme-mode` keywords to `['theme', 'mode', 'nord', 'dark', 'light', 'tokyonight', 'dim']`. Change the ThemePickerRow status text to `Selected extension theme is unavailable. Using Nord until it returns.`

- [ ] **Step 5: Write the CSS contract test**

Create `src/renderer/src/app-state/settings/nordTheme.test.ts`:

```ts
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { CUSTOM_APPEARANCE_CSS_VARS } from '@renderer/app-state/settings/customAppearance'

// Built-in themes exist ONLY as CSS (see savedThemes.ts), so the only way to
// assert "Nord defines every appearance token" is to read the stylesheet. The
// parser below is deliberately naive: styles.css declares its token blocks at
// the top level with no nesting, and that is all this needs to understand.
const css = readFileSync(resolve(__dirname, '../../styles.css'), 'utf8')

type Block = { selectors: string[]; declarations: Map<string, string> }

function blocks(): Block[] {
  const out: Block[] = []
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map(s => s.trim()).filter(Boolean)
    const declarations = new Map<string, string>()
    for (const decl of match[2].replace(/\/\*[\s\S]*?\*\//g, '').split(';')) {
      const [name, ...rest] = decl.split(':')
      if (name?.trim().startsWith('--')) declarations.set(name.trim(), rest.join(':').trim())
    }
    out.push({ selectors, declarations })
  }
  return out
}

const NORD = '[data-mode="dark-nord"]'

function nordScoped(block: Block): boolean {
  return block.selectors.some(s => s === ':root' || s === NORD || s === `:root${NORD}`)
}

describe('Nord built-in theme', () => {
  // The whole point of shipping Nord as a built-in rather than a saved theme
  // is that every one of the 81 tokens has a Nord value. A token that falls
  // through to the alias block is fine ONLY when the alias derivation equals
  // the Nord value; this test checks the union, so a token nobody defines
  // anywhere (a typo in the block, a new token added later) fails loudly.
  it('defines every appearance token for the default mode', () => {
    const defined = new Set<string>()
    for (const block of blocks().filter(nordScoped)) {
      for (const name of block.declarations.keys()) defined.add(name)
    }
    const missing = Object.values(CUSTOM_APPEARANCE_CSS_VARS).filter(v => !defined.has(v))
    expect(missing).toEqual([])
  })

  // First paint and unknown-mode degradation both read `:root`; if Nord ever
  // stops sharing that block the app flashes a different palette on launch.
  it('shares the first-paint palette with :root', () => {
    const base = blocks().find(b => b.selectors.includes(NORD) && b.declarations.has('--theme-canvas'))
    expect(base?.selectors).toContain(':root')
    expect(base?.declarations.get('--theme-canvas')).toBe('#171b21')
  })

  it('participates in the dark high-contrast override', () => {
    const contrast = blocks().find(b => b.selectors.includes(`[data-contrast="high"]${NORD}`))
    expect(contrast?.declarations.get('--theme-canvas')).toBe('#000000')
  })

  // The accent picker must keep working on Nord: every accent-tinted token in
  // the Nord blocks has to be expressed through var(--theme-accent), never as
  // a literal frost value that would ignore a user's Amber.
  it('derives accent tints from the accent variable', () => {
    for (const block of blocks().filter(b => b.selectors.includes(NORD) || b.selectors.includes(`:root${NORD}`))) {
      for (const [name, value] of block.declarations) {
        if (name === '--theme-accent') continue
        expect(value.toLowerCase(), name).not.toContain('136, 192, 208')
        expect(value.toLowerCase(), name).not.toContain('#88c0d0')
      }
    }
  })
})
```

- [ ] **Step 6: Run both tests to verify they pass**

Run: `npx vitest run src/renderer/src/app-state/settings/theme.renderer.test.ts src/renderer/src/app-state/settings/nordTheme.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/app-state/settings/types.ts src/renderer/src/styles.css src/renderer/src/features/settings/lib/settingsRegistry.ts src/renderer/src/features/settings/ui/ThemePickerRow.tsx src/renderer/src/app-state/settings/theme.renderer.test.ts src/renderer/src/app-state/settings/nordTheme.test.ts
git commit -m "feat(appearance): add the Nord theme and Frost accent as the defaults"
```

---

### Task 2: Retire the green from every fallback and hardcoded colour

**Files:**
- Modify: `src/renderer/src/app-state/settings/customAppearance.ts` (`DEFAULT_CUSTOM_APPEARANCE`, comment at ~line 300)
- Modify: `src/renderer/src/workspace/tile-tree/xtermTheme.ts`
- Modify: `src/renderer/src/lib/code/monacoRuntime.ts:68-86`
- Modify: `src/renderer/src/features/editor/lib/monacoEditorTheme.ts:45-75`
- Modify: `src/remote-client/src/styles.css:33-46`
- Modify: `src/main/window/appWindow.ts:176`
- Modify: `src/renderer/src/features/system-perf/ui/SystemPerfBadge.tsx:55-67,134`
- Modify: `src/renderer/src/features/system-perf/ui/SystemPerfPopover.tsx:294-318`
- Modify: comments naming Dark as the fallback in `theme.ts:85`, `store.ts:62`, `customAppearance.ts:300`
- Test (new): `src/renderer/src/workspace/tile-tree/xtermTheme.test.ts`

**Interfaces:**
- Produces: `colorWithAlpha(color: string, alpha: string, fallback: string, over?: string): string` exported from `xtermTheme.ts`.

- [ ] **Step 1: Write the failing xterm colour test**

```ts
import { describe, expect, it } from 'vitest'

import { colorWithAlpha } from '@renderer/workspace/tile-tree/xtermTheme'

describe('colorWithAlpha', () => {
  it('appends the alpha to six- and eight-digit hex', () => {
    expect(colorWithAlpha('#88c0d0', '44', '#000000ff')).toBe('#88c0d044')
    expect(colorWithAlpha('#88c0d0ff', '44', '#000000ff')).toBe('#88c0d044')
  })

  // Nord's muted ink is an alpha over the canvas. Before rgba() support the
  // terminal's inactive selection and scrollbar silently used the old dark
  // palette's literal fallback — the one place the green era survived.
  it('flattens an rgba() token over the canvas before applying the alpha', () => {
    expect(colorWithAlpha('rgba(216, 222, 233, 0.42)', '33', '#000000ff', '#171b21')).toBe('#686d7533')
  })

  it('returns the fallback for anything it cannot flatten', () => {
    expect(colorWithAlpha('color-mix(in srgb, red 50%, blue)', '33', '#686d7533')).toBe('#686d7533')
    expect(colorWithAlpha('rgba(1, 2, 3, 0.5)', '33', '#686d7533')).toBe('#686d7533')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/renderer/src/workspace/tile-tree/xtermTheme.test.ts`
Expected: FAIL — `colorWithAlpha` is not exported.

- [ ] **Step 3: Implement `colorWithAlpha` and the Nord fallbacks in xtermTheme.ts**

Replace `withAlpha` with:

```ts
// Turn a theme token into the flat `#rrggbbaa` xterm needs.
//
// WHY rgb()/rgba() is accepted and flattened over `over`: Nord — the default
// theme — expresses its muted ink as an alpha over the canvas
// (`rgba(216, 222, 233, 0.42)`). Before this, any non-hex token fell back to
// a literal from the old dark palette, so the terminal's inactive selection
// and scrollbar thumb were the one surface where the green-era colours
// survived a theme change. The token's own alpha is composited against
// `over` (the canvas) first, then the caller's per-surface `alpha` is
// appended; without `over` a translucent token cannot be flattened and the
// fallback is returned instead of guessing.
export function colorWithAlpha(color: string, alpha: string, fallback: string, over?: string): string {
  const normalized = color.trim()
  if (/^#[0-9a-f]{6}$/i.test(normalized)) return `${normalized}${alpha}`
  if (/^#[0-9a-f]{8}$/i.test(normalized)) return `${normalized.slice(0, 7)}${alpha}`
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([0-9.]+)\s*)?\)$/i.exec(normalized)
  if (!rgb) return fallback
  const source = rgb.slice(1, 4).map(part => Math.min(255, Number.parseInt(part, 10)))
  const sourceAlpha = rgb[4] === undefined ? 1 : Math.min(1, Math.max(0, Number.parseFloat(rgb[4])))
  const base = over === undefined ? null : /^#([0-9a-f]{6})$/i.exec(over.trim())
  if (sourceAlpha < 1 && !base) return fallback
  const channels = source.map((value, index) => {
    const under = base ? Number.parseInt(base[1].slice(index * 2, index * 2 + 2), 16) : 0
    return Math.round(sourceAlpha * value + (1 - sourceAlpha) * under)
  })
  return `#${channels.map(value => value.toString(16).padStart(2, '0')).join('')}${alpha}`
}
```

In `readXtermTheme` replace the fallback literals and calls:

```ts
  const background = readThemeToken(styles, '--theme-canvas', '#171b21')
  const foreground = readThemeToken(styles, '--theme-ink', '#d8dee9')
  const muted = readThemeToken(styles, '--theme-muted', '#686d75')
  const border = readThemeToken(styles, '--theme-border-hi', '#3b4252')
  const accent = readThemeToken(styles, '--theme-accent', '#88c0d0')
  const accentFg = readThemeToken(styles, '--theme-accent-fg', '#171b21')
  ...
    selectionBackground: colorWithAlpha(accent, '44', '#88c0d044', background),
    selectionInactiveBackground: colorWithAlpha(muted, '33', '#686d7533', background),
    scrollbarSliderBackground: colorWithAlpha(muted, '55', '#686d7555', background),
    scrollbarSliderHoverBackground: colorWithAlpha(muted, '88', '#686d7588', background),
    scrollbarSliderActiveBackground: colorWithAlpha(accent, 'aa', '#88c0d0aa', background),
```

- [ ] **Step 4: Replace the remaining literals**

`customAppearance.ts` — `DEFAULT_CUSTOM_APPEARANCE` becomes the Nord table from Global Constraints, key by key (81 entries, lowercase hex, rgba strings verbatim). Update the header comment above it:

```ts
// The Nord palette (#973) — identical to the `dark-nord` CSS blocks. This is
// the value a sparse saved or extension theme inherits for any token it omits,
// and the legacy `customAppearanceJson` seed, so it must track the DEFAULT
// built-in theme: a sparse theme backfilled with a palette the app no longer
// ships would look like a bug in the theme, not in the backfill.
```

Line ~300 comment: `user dropped back to Dark.` → `user dropped back to the default theme.`

`monacoRuntime.ts`: `'#12120f'` → `'#171b21'`, `'#e8e8e6'` → `'#d8dee9'`, `'#a8a8a4'` → `'#9aa0a9'`, `'#262622'` → `'#2e3440'`, both `'#7dd3a0'` → `'#88c0d0'`, `'#5a5a56'` → `'#686d75'`.

`monacoEditorTheme.ts`: `'#0a0a0a'` → `'#171b21'` (both), `'#e8e8e6'` → `'#d8dee9'`, `'#5a5a56'` → `'#686d75'` (all), `'#1a1a1c'` → `'#262b35'`, `'#272729'` → `'#3b4252'`, `'#7dd3a0'` → `'#88c0d0'` (all).

`src/remote-client/src/styles.css` `:root` fallbacks: bg `#171b21`, surface `#20242d`, surface-hi `#262b35`, border `#262b35`, border-hi `#3b4252`, ink `#d8dee9`, ink-dim `#9aa0a9`, muted `#686d75`, accent `#88c0d0`, accent-fg `#171b21`, danger `#bf616a`, ok `#88c0d0`.

`appWindow.ts:176`:

```ts
    // The Nord canvas (#973). This is what the window paints before the
    // renderer's first frame, so it must match the default theme's canvas or
    // every launch flashes a different colour for a frame.
    backgroundColor: '#171b21',
```

`SystemPerfBadge.tsx`: rewrite `strokeFor` to return theme variables and apply it through `style`:

```ts
// Stroke colour for the SVG polyline, as a theme variable.
//
// WHY `style={{ stroke }}` rather than the `stroke` attribute: presentation
// attributes are not guaranteed to resolve var(), the style property is. And
// WHY variables at all: the previous hex literals were Tailwind's -400 stops,
// which made the sparkline the only green left on screen after the Nord
// default landed (#973) and ignored light themes entirely.
function strokeFor(zone: Zone): string {
  switch (zone) {
    case 'red':
      return 'var(--theme-danger)'
    case 'yellow':
      return 'var(--theme-warning)'
    case 'green':
      return 'var(--theme-success)'
  }
}
```

and `stroke={stroke}` → `style={{ stroke }}`.

`SystemPerfPopover.tsx`: `stroke="#f87171"` → `style={{ stroke: 'var(--theme-danger)' }}`, `stroke="#38bdf8"` → `style={{ stroke: 'var(--theme-info)' }}`, `stroke="#34d399"` → `style={{ stroke: 'var(--theme-success)' }}` — matching the legend swatches `bg-danger` / `bg-info` / `bg-success` a few lines above, which already use the tokens.

`theme.ts:85` `reverting them to Dark.` → `reverting them to the default theme.`; `store.ts:62` `boot to Dark` → `boot to the default theme`.

- [ ] **Step 5: Run the test and grep for survivors**

Run: `npx vitest run src/renderer/src/workspace/tile-tree/xtermTheme.test.ts`
Expected: PASS.

Run: `grep -rn -i "7dd3a0\|34d399\|#0a0a0a" src/renderer/src src/remote-client src/main --include='*.ts' --include='*.tsx' --include='*.css' | grep -v "\.test\." | grep -v 'data-mode="dark"'`
Expected: only lines inside the legacy `[data-mode="dark"]` block and the `dark-dim`/high-contrast blocks that never used those values (i.e. none outside styles.css's legacy Dark block).

- [ ] **Step 6: Commit**

```bash
git add -A src/renderer/src/app-state/settings/customAppearance.ts src/renderer/src/workspace/tile-tree/xtermTheme.ts src/renderer/src/workspace/tile-tree/xtermTheme.test.ts src/renderer/src/lib/code/monacoRuntime.ts src/renderer/src/features/editor/lib/monacoEditorTheme.ts src/remote-client/src/styles.css src/main/window/appWindow.ts src/renderer/src/features/system-perf/ui/SystemPerfBadge.tsx src/renderer/src/features/system-perf/ui/SystemPerfPopover.tsx src/renderer/src/app-state/settings/theme.ts src/renderer/src/app-state/store.ts
git commit -m "feat(appearance): retire the green accent from every fallback and chart"
```

---

### Task 3: Migrate old-default installs and prune retired keys

**Files:**
- Modify: `src/renderer/src/app-state/settings/persistence.ts` (`coerceSettings` mode/accent lines, new `migrateLegacyDefaultAppearance`, `RETIRED_SETTINGS_KEYS`)
- Modify: `src/renderer/src/app-state/store.ts:73` (version 11 + comment)
- Test: `src/renderer/src/app-state/settings/persistence.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_SETTINGS.mode === 'dark-nord'`, `DEFAULT_SETTINGS.accent === 'frost'` from Task 1.

- [ ] **Step 1: Write the failing tests**

Append to `persistence.test.ts`:

```ts
describe('coerceSettings default appearance (#973)', () => {
  it('opens a fresh install in Nord with the Frost accent', () => {
    const settings = coerceSettings({})
    expect(settings.mode).toBe('dark-nord')
    expect(settings.accent).toBe('frost')
  })

  // The one deliberate exception to "persisted values win": a blob on exactly
  // the OLD default pair never had its appearance touched, so it follows the
  // default to Nord. Anything else is a choice and stays.
  it('moves an untouched Dark + Lime install to Nord + Frost', () => {
    const settings = coerceSettings({ mode: 'dark', accent: 'lime' })
    expect(settings.mode).toBe('dark-nord')
    expect(settings.accent).toBe('frost')
  })

  it('leaves a deliberate Dark theme alone when the accent was changed', () => {
    const settings = coerceSettings({ mode: 'dark', accent: 'gold' })
    expect(settings.mode).toBe('dark')
    expect(settings.accent).toBe('gold')
  })

  it('keeps a non-default theme and only replaces the retired green accents', () => {
    expect(coerceSettings({ mode: 'dark-dim', accent: 'lime' })).toMatchObject({ mode: 'dark-dim', accent: 'frost' })
    expect(coerceSettings({ mode: 'light', accent: 'sage' })).toMatchObject({ mode: 'light', accent: 'frost' })
  })

  it('is idempotent across a second hydration', () => {
    const once = coerceSettings({ mode: 'dark', accent: 'lime' })
    expect(coerceSettings(JSON.parse(JSON.stringify(once)))).toMatchObject({ mode: 'dark-nord', accent: 'frost' })
    // …and a user who goes back to Dark afterwards is not migrated again.
    expect(coerceSettings({ ...once, mode: 'dark' })).toMatchObject({ mode: 'dark', accent: 'frost' })
  })
})

describe('coerceSettings retired keys', () => {
  // Found riding in a long-lived install's blob during the #973 audit: each
  // was a Settings field once, and `...parsed` copies whatever it finds, so
  // every one had survived every save since its field was deleted.
  it.each([
    'customRendering',
    'codeLineWrap',
    'showTerminalPreview',
    'showSystemEvents',
    'highContrast',
    'eventDrivenPasteSubmit',
    'dispatchProjectTerminal',
  ])('drops %s instead of carrying it forever', key => {
    expect(coerceSettings({ [key]: true })).not.toHaveProperty(key)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/renderer/src/app-state/settings/persistence.test.ts`
Expected: FAIL on the Nord/Frost expectations and on the six new retired keys.

- [ ] **Step 3: Implement the migration and the retired list**

In `persistence.ts`, next to `migrateLegacyCustomAppearance`:

```ts
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
const LEGACY_DEFAULT_MODE = 'dark'
const LEGACY_DEFAULT_ACCENT = 'lime'

function migrateLegacyDefaultAppearance(
  parsed: Partial<Settings>,
): Pick<Settings, 'mode' | 'accent'> | null {
  if (parsed.mode !== LEGACY_DEFAULT_MODE || parsed.accent !== LEGACY_DEFAULT_ACCENT) return null
  return { mode: DEFAULT_SETTINGS.mode, accent: DEFAULT_SETTINGS.accent }
}
```

In `coerceSettings`, before the returned object: `const legacyAppearance = migrateLegacyDefaultAppearance(parsed)`; then

```ts
    mode: legacyAppearance?.mode ?? resolvePersistedMode(parsed, savedThemes),
    ...
    // A retired accent id ('lime', 'sage') fails the membership test and lands
    // on Frost — that is the intended landing for the green accents (#973).
    accent: legacyAppearance?.accent
      ?? (ACCENTS.some(a => a.id === parsed.accent)
        ? (parsed.accent as AccentId)
        : DEFAULT_SETTINGS.accent),
```

Extend `RETIRED_SETTINGS_KEYS`:

```ts
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
```

In `store.ts` bump `version: 10` → `version: 11` and append to the comment block:

```ts
        //
        // v11 reinterprets the old default appearance: a blob on Dark + Lime
        // becomes Nord + Frost, and the Lime/Sage accent ids are retired
        // (#973). coerceSettings does the work on every hydration; the bump is
        // the record that a persisted VALUE changed meaning, per the rule above.
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/renderer/src/app-state/settings/persistence.test.ts src/renderer/src/features/command-palette/taxonomy.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/app-state/settings/persistence.ts src/renderer/src/app-state/settings/persistence.test.ts src/renderer/src/app-state/store.ts
git commit -m "feat(settings): migrate untouched Dark installs to Nord and prune retired keys"
```

---

### Task 4: Dispatch with global scope as the default view

**Files:**
- Modify: `src/renderer/src/app-state/settings/types.ts` (`DEFAULT_SETTINGS.defaultWorkspaceMode`)
- Modify: `src/renderer/src/workspace/hook/persistence/useBootstrap.ts:101-104`
- Modify: `src/renderer/src/workspace/hook/actions/dispatch.ts:127,213`
- Test: `src/renderer/src/app-state/settings/persistence.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
describe('coerceSettings default workspace mode (#973)', () => {
  it('opens a fresh install in Dispatch', () => {
    expect(coerceSettings({}).defaultWorkspaceMode).toBe('dispatch')
  })

  it('keeps an explicit Grid preference', () => {
    expect(coerceSettings({ defaultWorkspaceMode: 'grid' }).defaultWorkspaceMode).toBe('grid')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/renderer/src/app-state/settings/persistence.test.ts -t "default workspace mode"`
Expected: FAIL — `grid`.

- [ ] **Step 3: Implement**

`types.ts`:

```ts
  // Dispatch is the product's command-center view and the way the owner runs
  // the app all day; a public fresh install should open there (#973). The
  // setting still only seeds a workspace that has no workspace.json yet.
  defaultWorkspaceMode: 'dispatch',
```

`useBootstrap.ts`:

```ts
            if (defaultWorkspaceMode === 'dispatch') {
              try {
                // Global, not project (#973): a fresh install has exactly one
                // tab, so project scope would show the same agents while
                // hiding the scope switch's purpose; global is also the scope
                // the owner runs in and the one every later tab benefits from.
                await enterDispatchMode('global')
```

`dispatch.ts` line 127 and line 213: `?? 'project'` → `?? 'global'`, each with:

```ts
      // Global is the default scope (#973): entering Dispatch from a workspace
      // that never used it should show the whole fleet, matching what a fresh
      // install boots into. A persisted scope always wins over this fallback.
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/renderer/src/app-state/settings/persistence.test.ts src/renderer/src/workspace/dispatch src/renderer/src/workspace/hook/actions`
Expected: PASS (no test asserts the fallback scope; the dispatch suites construct their own scope).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/app-state/settings/types.ts src/renderer/src/workspace/hook/persistence/useBootstrap.ts src/renderer/src/workspace/hook/actions/dispatch.ts src/renderer/src/app-state/settings/persistence.test.ts
git commit -m "feat(workspace): open fresh installs in global Dispatch"
```

---

### Task 5: Public-release defaults for the remaining preferences

**Files:**
- Modify: `src/renderer/src/app-state/settings/types.ts` (`DEFAULT_SETTINGS` fields + comments)
- Modify: `src/renderer/src/lib/hotkeyBinding.ts:15`
- Modify: `src/renderer/src/app-state/settings/persistence.ts` (coercions)
- Test: `src/renderer/src/app-state/settings/persistence.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the existing `defaults missing built-in MCP defaults to an empty list` test with, and append:

```ts
  it('seeds the owner-recommended built-in MCP domains on a fresh install', () => {
    expect(coerceSettings({}).defaultBuiltInMcpDomains)
      .toEqual(['tldr', 'goal', 'orchestration', 'agent_transcripts', 'workflows'])
  })

  it('respects an explicit empty MCP domain list', () => {
    expect(coerceSettings({ defaultBuiltInMcpDomains: [] }).defaultBuiltInMcpDomains).toEqual([])
  })
```

```ts
describe('coerceSettings public-release defaults (#973)', () => {
  // Each pair: an absent key resolves to the new default; an explicit value
  // — including the old default — is preserved. This is the promise that a
  // default flip never overrides a persisted choice.
  it.each([
    ['mouseModeEnabled', true, false],
    ['dangerousAgentsEnabled', true, false],
    ['usageHeaderEnabled', false, true],
    ['autoSendPromptSuggestion', false, true],
  ] as const)('%s defaults to %s but keeps an explicit %s', (key, fresh, explicit) => {
    expect(coerceSettings({})[key]).toBe(fresh)
    expect(coerceSettings({ [key]: explicit })[key]).toBe(explicit)
  })

  it('sorts the command picker by recency on a fresh install', () => {
    expect(coerceSettings({}).commandSortMode).toBe('recent')
    expect(coerceSettings({ commandSortMode: 'catalog' }).commandSortMode).toBe('catalog')
  })

  it('ships the owner dictation and palette bindings without turning dictation on', () => {
    const fresh = coerceSettings({})
    expect(fresh.dictationEnabled).toBe(false)
    expect(fresh.dictationShortcut).toBe('Fn')
    expect(fresh.dictationMouseButton).toBe('Middle')
    expect(fresh.paletteMouseChord).toBe('Middle+Right')
  })

  it('keeps explicitly cleared bindings cleared', () => {
    const cleared = coerceSettings({ dictationShortcut: 'off', dictationMouseButton: '', paletteMouseChord: '' })
    expect(cleared.dictationShortcut).toBe('')
    expect(cleared.dictationMouseButton).toBe('')
    expect(cleared.paletteMouseChord).toBe('')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/renderer/src/app-state/settings/persistence.test.ts`
Expected: FAIL on every new expectation.

- [ ] **Step 3: Implement**

`hotkeyBinding.ts:15`:

```ts
// Fn is the shipped binding (#973). It is safe as a DEFAULT because the
// binding only reaches main once `dictationEnabled` is true
// (useDictationHotkeySync sends '' otherwise), so the Accessibility prompt
// the CGEventTap needs stays behind the user's own decision to turn
// dictation on. The settings row already warns about the permission.
export const DEFAULT_DICTATION_HOTKEY = 'Fn'
```

`types.ts` `DEFAULT_SETTINGS` (replace the old dictationShortcut comment block and the other fields):

```ts
  dangerousAgentsEnabled: true,
  ...
  // WHY Fn, after this file spent a long comment explaining why Cmd+Shift+D
  // replaced it: the objection was a first-launch Accessibility prompt, and
  // that no longer applies — useDictationHotkeySync sends an EMPTY binding
  // to main while dictation is off, so the CGEventTap helper is never armed
  // until the user enables dictation. With that gate in place the binding
  // can be the one the owner actually uses (#973). Same source of truth as
  // coerceHotkeyBinding's fallback.
  dictationShortcut: DEFAULT_DICTATION_HOTKEY,
  // Middle click for hold-to-talk, and Middle+Right for the command palette:
  // the owner's bindings, shipped as the public defaults (#973). The mouse
  // dictation trigger is gated on dictationEnabled just like the key; the
  // palette chord is live immediately, which is the point of shipping it.
  dictationMouseButton: 'Middle',
  paletteMouseChord: 'Middle+Right',
  ...
  defaultBuiltInMcpDomains: ['tldr', 'goal', 'orchestration', 'agent_transcripts', 'workflows'],
  autoSendPromptSuggestion: false,
  ...
  commandSortMode: 'recent',
  ...
  mouseModeEnabled: true,
  ...
  usageHeaderEnabled: false,
```

with the short WHY next to each flipped field:

```ts
  // On by default for the public build — the owner's explicit call (#973):
  // Agent Code is a workspace for people who run many agents at once, and the
  // permission prompts were the first thing every user turned off. The
  // Settings row stays marked dangerous and reloads live sessions on change.
  dangerousAgentsEnabled: true,
```

```ts
  // The owner's day-to-day set, shipped as the default (#973). TLDR and Goal
  // are the Cmd+L / Cmd+G peeks — with no domains on, a new user never sees
  // them do anything. AI Workspace and Agent Management stay opt-in.
  defaultBuiltInMcpDomains: ['tldr', 'goal', 'orchestration', 'agent_transcripts', 'workflows'],
```

```ts
  // Off (#973): a click that immediately sends a prompt to an agent surprised
  // the owner enough to turn it off; fill-then-edit is the safer public default.
  autoSendPromptSuggestion: false,
```

```ts
  // Recent (#973): with no history it IS catalog order, so a new user loses
  // nothing, and it improves the moment they run a command.
  commandSortMode: 'recent',
```

```ts
  // On (#973): the Send/Stop buttons are the only discoverable way to drive a
  // pane for someone who has not learned the keys yet; 28px per pane is worth it.
  mouseModeEnabled: true,
```

```ts
  // Off (#973): the header quota indicator is opt-in for the public build; the
  // Usage command and modal are unaffected.
  usageHeaderEnabled: false,
```

Import `DEFAULT_DICTATION_HOTKEY` into `types.ts` from `@renderer/lib/hotkeyBinding` (verify first that `hotkeyBinding.ts` does not import from `settings/types`; it does not today).

`persistence.ts` coercions:

```ts
    // `!== false`: absent → on (the #973 default); only an explicit persisted
    // `false` keeps dangerous mode off. Same idiom as useProxyStreaming.
    dangerousAgentsEnabled: parsed.dangerousAgentsEnabled !== false,
    ...
    dictationShortcut: coerceHotkeyBinding(parsed.dictationShortcut),
    // Absent → the shipped binding; present → the closed-enum coercion. The
    // split matters because '' is a VALID persisted value meaning "off", and
    // an install that turned the button off must not get it back on upgrade.
    dictationMouseButton: parsed.dictationMouseButton === undefined
      ? DEFAULT_SETTINGS.dictationMouseButton
      : coerceMouseButtonBinding(parsed.dictationMouseButton),
    paletteMouseChord: parsed.paletteMouseChord === undefined
      ? DEFAULT_SETTINGS.paletteMouseChord
      : coerceMouseChordBinding(parsed.paletteMouseChord),
    ...
    // `=== true`: absent → off (the #973 default); an explicit `true` from an
    // older blob keeps autosend on for the user who had it.
    autoSendPromptSuggestion: parsed.autoSendPromptSuggestion === true,
    usageHeaderEnabled: parsed.usageHeaderEnabled === true,
    ...
    // Absent → the shipped domain set; present (even `[]`) → normalized as
    // before. An explicit empty list is a real choice ("no MCP by default").
    defaultBuiltInMcpDomains: parsed.defaultBuiltInMcpDomains === undefined
      ? [...DEFAULT_SETTINGS.defaultBuiltInMcpDomains]
      : normalizeConfigurableBuiltInMcpDomains(parsed.defaultBuiltInMcpDomains),
    ...
    mouseModeEnabled: parsed.mouseModeEnabled !== false,
```

Update the existing comments on `autoSendPromptSuggestion` / `usageHeaderEnabled` / `mouseModeEnabled` so they no longer claim the opposite default.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/renderer/src/app-state/settings src/renderer/src/features/command-palette/taxonomy.test.ts src/renderer/src/control/documentation.renderer.test.ts src/renderer/src/lib`
Expected: PASS. If `hotkeyBinding.test.ts` fails on a pre-existing assertion unrelated to the default (memory says it has a known failure), record it in the PR; if it asserts `Cmd+Shift+D` as the default, update that assertion to `Fn`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/app-state/settings/types.ts src/renderer/src/lib/hotkeyBinding.ts src/renderer/src/app-state/settings/persistence.ts src/renderer/src/app-state/settings/persistence.test.ts
git commit -m "feat(settings): ship the owner's preferences as the public defaults"
```

---

### Task 6: Promote eight daily commands to the default picker tier

**Files:**
- Modify: `src/renderer/src/features/workspace/commands/sessionCommands.ts` (`rewind-to-prompt` ~135, `close-old-agents` ~336, `search-conversation-prompts` ~458, `copy-resume-command` ~917, `duplicate-agent` ~972, `switch-provider` ~1058)
- Modify: `src/renderer/src/features/copy-code-block/commands/copyCodeBlockCommands.ts:35-38`
- Modify: `src/renderer/src/features/copy-assistant/commands/copyAssistantCommands.ts:13-16`
- Test: `src/renderer/src/features/command-palette/taxonomy.test.ts:99-110`

- [ ] **Step 1: Update the taxonomy test first**

```ts
  it('keeps daily reversible actions in the default tier', () => {
    for (const id of [
      'new-tab', 'close-tab', 'toggle-git-bar', 'reload-agent',
      // Promoted from `advanced` for the public release (#973): every one of
      // these was un-hidden by hand on the owner's install, which is the
      // strongest signal available that they are daily rather than niche.
      'search-conversation-prompts', 'duplicate-agent', 'rewind-to-prompt', 'close-old-agents',
      'copy-code-block', 'copy-assistant-message', 'copy-resume-command', 'switch-provider',
    ]) {
      expect(byId(id).pickerVisibility ?? 'default').toBe('default')
    }
  })

  it('marks niche supported operations advanced rather than hiding them entirely', () => {
    for (const id of ['remove-cybersecurity-block', 'normalize-layout', 'bury-pane', 'soft-reload-agent', 'switch-agents-provider']) {
      expect(byId(id).pickerVisibility).toBe('advanced')
    }
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/renderer/src/features/command-palette/taxonomy.test.ts`
Expected: FAIL — the eight ids are `advanced`.

- [ ] **Step 3: Remove the tier from the eight declarations**

Delete the `pickerVisibility: 'advanced',` line from each of the eight command definitions and replace it with:

```ts
    // Default tier since the public-release audit (#973): un-hidden by hand
    // on the owner's install, i.e. a daily action, not a niche one.
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/renderer/src/features/command-palette`
Expected: PASS (the `advanced` count stays above 10: 28 remain).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/workspace/commands/sessionCommands.ts src/renderer/src/features/copy-code-block/commands/copyCodeBlockCommands.ts src/renderer/src/features/copy-assistant/commands/copyAssistantCommands.ts src/renderer/src/features/command-palette/taxonomy.test.ts
git commit -m "feat(commands): promote eight daily commands to the default picker tier"
```

---

### Task 7: Verification and PR

- [ ] **Step 1: Type-check both projects**

Run: `export PATH="$HOME/.nvm/versions/node/v24.14.1/bin:$PATH" && npx tsc -b`
Expected: no errors.

- [ ] **Step 2: Run the touched suites once**

Run: `npx vitest run src/renderer/src/app-state/settings src/renderer/src/features/command-palette src/renderer/src/workspace/tile-tree/xtermTheme.test.ts src/renderer/src/control src/renderer/src/lib src/main/extensions/manifest.test.ts src/renderer/src/features/settings`
Expected: PASS, except any failure listed in the known-local-env-failures memory.

- [ ] **Step 3: Grep for survivors**

Run: `grep -rn -i "7dd3a0\|4ade80\|34d399\|'lime'\|'sage'" src --include='*.ts' --include='*.tsx' --include='*.css' | grep -v "\.test\."`
Expected: hits only inside styles.css legacy blocks (`[data-mode="dark"]`, `dark-dim` success, `light` diff-add, high-contrast) and the xterm ANSI table.

- [ ] **Step 4: Push and open the PR**

Title: `feat(defaults): ship Nord theme, global Dispatch and public-release defaults`
Body: problem, implemented behavior, decisions (accent removal, the one migration, Fn gating, dangerous-agents call), `Fixes #973`, verification output, limitations (no hook-level bootstrap test; existing installs keep explicit values). Do not merge.
