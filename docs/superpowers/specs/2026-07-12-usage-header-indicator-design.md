# Usage Header Indicator — Design Spec

> **Date:** 2026-07-12
> **Status:** approved design (user-approved in session; implementation plan follows in `docs/superpowers/plans/`)
> **Scope decisions (user-locked):** show **all** limit rows, not just an aggregate · four display levels (`minimal` / `providers` / `all` / `detailed`), default `all` · master toggle in Settings **and** a palette command, plus a level selector in Settings **and** a level-cycling palette command · click-through opens the existing Usage modal
> **Branch:** `feat/usage-header-indicator` in `.worktrees/usage-header-indicator`

---

## 1. Why this feature exists

Provider quota is currently visible only on demand: open the palette, run **Usage**, read the modal, close it. But quota is a *planning* input — "can I afford to dispatch six more Claude agents tonight, or should I shift the fleet to Codex?" — and planning inputs belong in ambient chrome, not behind a modal. Agent Code's whole premise is running Claude and Codex side by side; which provider has headroom is a first-class glanceable fact.

The main-process plumbing already exists and is NOT changed by this feature:

- `src/main/usage/usageService.ts` — `getUsageSnapshot()` reads Claude (OAuth token from the Claude Code Keychain entry) and Codex (`~/.codex/auth.json`) quotas, with a **30s in-memory cache** and per-provider failure isolation.
- IPC `usage:get-snapshot` (`src/main/ipc/usage.ts`) → `window.api.getUsageSnapshot(request?)` (`src/preload/api/usage.ts`).
- Renderer already has the modal (`features/usage/ui/UsageModal.tsx`), severity/format helpers (`features/usage/model/formatUsage.ts`), and the palette command `usage.open`.

This feature is purely a **renderer-side ambient consumer** of that snapshot: a polling hook plus a header widget, gated by settings.

## 2. What the snapshot actually contains (source of truth for the UI)

From `src/shared/types/usage.ts` and the provider readers:

- **Claude** rows (labels produced by `labelClaudeLimit`): `Current session`, `Current week (all models)`, `Current week (<model display name>)` (e.g. Fable). Each row: `percent: number | null`, `severity: normal|warning|critical|unknown`, `resetsAt: ISO | null`, `active: boolean`, `detail`.
- **Codex** rows (from `codexRowsFromRateLimit`): rate-limit windows such as the 5-hour window and the weekly window, same row shape.
- Either provider can independently be `status: 'error'` (stale token, no auth file, network down). **A Codex failure must never hide Claude data** — the header inherits the same per-provider isolation the modal has.

## 3. UX design (user-approved ASCII)

The widget lives in `SettingsBar` (`src/renderer/src/app/shell/SettingsBar.tsx`) — the compact chrome row under the tabs — to the **left** of the existing `AppearanceMenu` / `perf` / `caff` buttons, matching their visual language (bordered chips, `font-code`, 10px text, `[-webkit-app-region:no-drag]`).

Four display levels, all shipped, selected by `usageHeaderLevel`:

**`minimal`** — single chip, worst (highest-percent) active limit across both providers:

```
[ usage 62% ]
```

**`providers`** — one chip per provider, each showing that provider's worst active limit:

```
[ CL 62% ] [ CX 14% ]
```

**`all`** (default) — every active limit row, compact short labels:

```
[ CL  ses 62% · wk 41% · fable 18% ]  [ CX  5h 14% · wk 8% ]
```

**`detailed`** — everything in `all` plus a severity-colored micro-bar (~28px inline block) and a compact reset countdown per row, still one line:

```
[ CL  ses ▓▓▓▓▓░░ 62% 3h │ wk ▓▓▓░░░ 41% 4d │ fable ▓░░░░░ 18% 4d ]  [ CX  5h ▓░░░░░ 14% 2h │ wk ▓░░░░░ 8% 6d ]
```

Shared behavior at every level:

- **Severity colors** — percent text (and bars in `detailed`) use the exact same mapping as the modal: `severityTextStyle` / `severityBarStyle` from `formatUsage.ts` (accent → hard-coded amber `#d97706` → `--theme-danger`; `unknown` → muted). No new color system.
- **Click** anywhere on the widget → `openUsageModal()` (existing uiShell action). The modal remains the detail/refresh surface.
- **Tooltip** (`title` attribute) — full row labels, exact percents, and `resets in …` strings, so even `minimal` exposes everything on hover.
- **Chip order** — Claude then Codex, rows in snapshot order (the providers already order them meaningfully: session before weekly).

### 3.1 Short-label derivation

Header chips can't fit `Current week (all models)`. A `shortRowLabel(row)` helper maps known label shapes to compact forms, with a truncation fallback for shapes we haven't seen:

- `Current session` → `ses`
- `Current week (all models)` → `wk`
- `Current week (<model>)` → lowercased model name (`fable`)
- Codex `<n>h …` windows → `<n>h`; `Weekly …` → `wk`
- Anything else → first word lowercased, max 6 chars

This is a display-only mapping in the renderer; it must NOT feed back into row identity (`row.id` stays the key).

### 3.2 Degraded states

- **One provider errored** → its chip is simply absent; the other renders normally. (Header is glanceable chrome; error prose belongs in the modal.)
- **Both providers errored / no rows** → single muted chip `usage n/a`, tooltip carries the provider error messages, click still opens the modal (where the full error text and refresh live).
- **First poll in flight** → render nothing (no skeleton flash in chrome; data arrives within ~1s).
- **Poll failure after success** → keep showing the last good snapshot; tooltip appends `(stale — last updated HH:MM)`. Never blank out working chrome because one poll failed.
- **`percent: null`** rows render `?%` styled as `unknown` severity, and are skipped when computing "worst" for `minimal`/`providers` (a row with unknown percent can't win "most constrained").
- **Inactive rows** (`active: false`) are excluded at every level — the modal shows them, the header shows only limits currently in force.

## 4. Settings

Two new keys in `Settings` (`src/renderer/src/app-state/settings/types.ts`):

```ts
usageHeaderEnabled: boolean          // default: true
usageHeaderLevel: UsageHeaderLevel   // 'minimal' | 'providers' | 'all' | 'detailed', default: 'all'
```

- `UsageHeaderLevel` is a curated string union with an exported ordered list `USAGE_HEADER_LEVELS` (same pattern as `FONT_FAMILIES` / `THEME_MODES`) — the ordered list is what the cycle command walks.
- **Persistence coercion** (`app-state/settings/persistence.ts` → `coerceSettings`): `usageHeaderEnabled: parsed.usageHeaderEnabled !== false` (default-true pattern, same as `showWorktreeBadges`); `usageHeaderLevel` falls back to `'all'` on any unknown string so corrupted localStorage can't break the header.
- **Settings page** (`features/settings/lib/settingsRegistry.ts`): two entries —
  - toggle **"Usage in header"** — `control.type: 'toggle'`, `getValue: s => s.usageHeaderEnabled`, `onToggle: (ctx, v) => ctx.onChange({ usageHeaderEnabled: v })`
  - select **"Usage header detail"** — `control.type: 'select'` over the four levels with one-line descriptions per option; disabled-state is NOT modeled (the registry has no dependent-visibility concept; the select simply has no visible effect while the toggle is off, and its description says so).

## 5. Commands

Both added to `features/usage/commands/usageCommands.ts` (already spread into the palette registry):

1. **`usage.toggle-header`** — title "Usage in Header", surface `app`. `getState` reports On/Off with accent/neutral tone (same shape as `toggle-worktree-badges`). `run` flips the setting.
2. **`usage.cycle-header-level`** — title "Usage Header Detail", surface `app`. `getState` label is the current level name (`all`, `detailed`, …). `run` advances through `USAGE_HEADER_LEVELS` circularly (`minimal → providers → all → detailed → minimal`). If the header is currently disabled, cycling also enables it — a user reaching for "more usage detail" obviously wants the widget visible.

Command context plumbing: commands read state through `CommandContext.flags` and mutate through `ctx.ui` actions (see `CommandPalette.tsx` where both are assembled from `useAppStore`). Two new flags (`usageHeaderEnabled`, `usageHeaderLevel`) and the corresponding `ui` setter(s) follow the existing `toggleWorktreeBadges` pattern — thin wrappers over `setSettings`.

## 6. Polling architecture

New hook `features/usage/hooks/useUsageHeaderSnapshot.ts`, consumed only by the header widget:

- **Interval: 60s**, non-forced (`getUsageSnapshot({})`). The main-process 30s cache means the header's poll frequency and the modal's on-open fetch can never stampede the provider APIs — worst case one real upstream fetch per 30s regardless of how many consumers poll. WHY 60s and not 30s: quota percentages move on multi-minute timescales; 60s halves IPC chatter for zero perceptible staleness (and the cache would serve half the 30s polls stale-free anyway).
- **Visibility-gated**: interval pauses while `document.visibilityState === 'hidden'`, with an immediate refresh on the `visibilitychange` back to visible. This repo has been burned by background polling before (see the proxy-events full-file poll OOM and the 60Hz screen-snapshot GC churn memories); ambient chrome must not tick in a hidden window.
- **Lifecycle-gated**: the hook lives inside the widget, and the widget returns `null` before hooks only via parent gating — `SettingsBar` renders `<UsageHeaderIndicator />` only when `settings.usageHeaderEnabled`, so disabling the feature unmounts the widget and tears down the interval. Zero cost when off.
- **No new store slice**: snapshot state is component-local (`useState` in the hook). Nothing else in the app consumes it; promoting it to zustand would be enforcement-free bloat. If a second consumer ever appears, lift it then.
- The modal keeps its own fetch logic untouched; the shared main-process cache keeps the two views coherent within 30s.

## 7. Component structure

```
features/usage/
  hooks/useUsageHeaderSnapshot.ts   ← polling + visibility gating + stale tracking
  model/headerRows.ts               ← pure selectors: active rows, worst-of, shortRowLabel,
                                       compact reset (formatResetShort: "3h"/"4d"/"soon")
  ui/UsageHeaderIndicator.tsx       ← the widget: level switch → chip layout; click → openUsageModal
```

- `headerRows.ts` is pure data → data (testable by inspection, no DOM); `UsageHeaderIndicator` is layout only. `formatUsage.ts` gains `formatResetShort` (reuses `formatReset`'s bucketing, drops the `resets in ` prefix) rather than duplicating the date math.
- `SettingsBar.tsx` change is three lines: read the two settings, conditionally render `<UsageHeaderIndicator level={...} />` at the left of the chrome group.
- Per-repo comment policy: every non-obvious decision above (poll cadence vs cache TTL, visibility gating, why component-local state, why inactive rows are excluded) gets a thick WHY comment at the implementation site.

## 8. Testing / verification

- Per the standing no-test-bloat rule: **no new test files**. Existing suites must stay green.
- Verification gate: `tsc -p tsconfig.node.json` + `tsc -p tsconfig.web.json` (the pre-existing `electron.vite.config.ts` TS2769 error on `main` is the known baseline), then live verification in `npm run dev`: toggle via Settings, toggle via palette, cycle all four levels, click-through to modal, and confirm chips vanish when a provider's auth is absent.

## 9. Out of scope

- No main-process changes (service, IPC, cache TTL all untouched).
- No spend/credits in the header (modal-only; header is quota pressure, not billing).
- No per-provider enable/disable (the level system covers density; provider filtering is YAGNI until asked).
- No OpenCode: the usage service only models `claude | codex` (`UsageProviderKind`), and that boundary is upstream of this feature.
