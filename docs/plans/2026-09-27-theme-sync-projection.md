# Theme sync only on theme inputs (#784)

**Measured on origin/main**, with `useThemeSync.renderer.test.tsx` counting `THEME_CHANGED_EVENT` and the mirror IPC:
- a usage-header / status-mode / worktree-badge / usage-level change costs **2 theme applications**. Each application rewrites the inline palette, fonts and radii and fires THEME_CHANGED_EVENT, which every xterm and Monaco re-reads.
- a dispatch colour flag costs **1** application.
- each mirror sends the **full 40-key settings object** over IPC to the phone.

## Rule
- **`THEME_SETTING_KEYS`** (`theme.ts`) lists exactly the settings `applyTheme` / `resolveThemePayload` read: `mode`, `contrast`, `accent`, `fontFamily`, `cornerStyle`, `savedThemes`, `customAppearanceJson`. Installed extensions are the other input.
- **`useThemeSync`** selects only those keys (`useShallow`) plus the extensions. It applies and mirrors only when one of them changes identity.
- **The mirror carries only the theme keys.** The phone merges it into its defaults and runs `applyTheme`, nothing else.
- **`setSettings` still applies synchronously**, so the change is visible in the same frame, but only for a patch that touches a theme key. The chrome toggles no longer apply at all.

## Preserved
- the pre-hydration default at module load;
- hydration (coerced values differ from the defaults, so the effect runs);
- saved-theme edits (a new `savedThemes` array);
- extension changes (`uiShell/slice` still re-applies on install, and the effect mirrors);
- reset.

## After
All unrelated changes cost 0 applications and 0 IPC. A theme change still applies at once and mirrors once.
