# Usage Header Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A settings-gated, palette-toggleable widget in the `SettingsBar` header row that polls the existing `usage:get-snapshot` IPC and shows Claude + Codex quota rows at four selectable detail levels, clicking through to the existing Usage modal.

**Architecture:** Pure renderer feature. Main process (`usageService`, IPC, 30s cache) is untouched. New: two `Settings` keys + coercion, a polling hook (60s, visibility-gated, component-local state), a pure row-shaping module, one widget component, two settings-registry entries, two palette commands with flags/ui plumbing.

**Tech Stack:** React 18, zustand (`useAppStore`), Tailwind classes matching existing `SettingsBar` chips, existing `formatUsage.ts` severity helpers.

**Spec:** `docs/superpowers/specs/2026-07-12-usage-header-indicator-design.md` — read it first; every UX decision (levels, short labels, degraded states) is locked there.

## Global Constraints

- Worktree: `.worktrees/usage-header-indicator`, branch `feat/usage-header-indicator`. All commands run from the worktree root.
- **No new test files** (standing user rule). Per-task verification is `npx tsc -p tsconfig.web.json --noEmit` (expect **0 errors**; run `npx tsc -p tsconfig.node.json` first if `.tsc-out/` is missing). The node project has one pre-existing error in `electron.vite.config.ts` (TS2769) — it exists on `main`, ignore it.
- Full test suite (`NODE_ENV=test npx vitest run`) runs ONCE, in the final task. Known pre-existing failure: `hotkeyBinding.test.ts`.
- Thick WHY comments on every non-obvious decision (repo CLAUDE.md policy). The code blocks below include them — keep them.
- Settings defaults: `usageHeaderEnabled: true`, `usageHeaderLevel: 'all'`.
- Level order (cycle command walks this exactly): `minimal → providers → all → detailed → minimal`.
- Command ids (stable, referenced by `commandVisibilityOverrides`): `usage.toggle-header`, `usage.cycle-header-level`.

---

### Task 1: Settings keys, level union, persistence coercion

**Files:**
- Modify: `src/renderer/src/app-state/settings/types.ts` (Settings type ends ~line 328, `DEFAULT_SETTINGS` starts ~line 330)
- Modify: `src/renderer/src/app-state/settings/persistence.ts` (`coerceSettings`, lines 15–86)

**Interfaces:**
- Produces: `type UsageHeaderLevel = 'minimal' | 'providers' | 'all' | 'detailed'`, `const USAGE_HEADER_LEVELS: readonly UsageHeaderLevel[]`, `Settings.usageHeaderEnabled: boolean`, `Settings.usageHeaderLevel: UsageHeaderLevel` — all exported from `@renderer/app-state/settings/types`. Every later task consumes these names verbatim.

- [ ] **Step 1: Add the level union + ordered list to `types.ts`** (above the `Settings` type):

```ts
/** Detail levels for the header usage indicator, ordered from least to
 *  most detail. The ORDER is load-bearing: the `usage.cycle-header-level`
 *  palette command advances through this array circularly, and the
 *  settings-page select lists options in this order. Add new levels in
 *  display order, never alphabetically. */
export const USAGE_HEADER_LEVELS = ['minimal', 'providers', 'all', 'detailed'] as const
export type UsageHeaderLevel = (typeof USAGE_HEADER_LEVELS)[number]
```

- [ ] **Step 2: Add the two keys to the `Settings` type** (after `commandVisibilityOverrides`):

```ts
  /** Ambient provider-quota indicator in the SettingsBar header row.
   *  On by default: quota headroom is a planning input for dispatching
   *  agent fleets, and the whole point of the feature is ambient
   *  visibility. The widget is fully unmounted when off (its polling
   *  hook lives inside the component), so the off state costs nothing. */
  usageHeaderEnabled: boolean
  /** How much of the usage snapshot the header shows. 'all' (every
   *  active limit row, compact labels) is the default per the design
   *  spec — an aggregate-only number was explicitly rejected as not
   *  enough. See docs/superpowers/specs/2026-07-12-usage-header-indicator-design.md §3. */
  usageHeaderLevel: UsageHeaderLevel
```

- [ ] **Step 3: Add defaults to `DEFAULT_SETTINGS`**: `usageHeaderEnabled: true,` and `usageHeaderLevel: 'all',`

- [ ] **Step 4: Coerce both keys in `persistence.ts`** — import `USAGE_HEADER_LEVELS` and add inside the returned object of `coerceSettings` (after `autoSendPromptSuggestion`):

```ts
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
```

(also add `USAGE_HEADER_LEVELS` and `type UsageHeaderLevel` to the existing import from `@renderer/app-state/settings/types`)

- [ ] **Step 5: Verify** — `npx tsc -p tsconfig.web.json --noEmit` → 0 errors.

- [ ] **Step 6: Commit** — `git add -A src/renderer/src/app-state/settings && git commit -m "feat(usage-header): settings keys, level union, coercion"`

---

### Task 2: Pure header-row model + compact reset formatter

**Files:**
- Create: `src/renderer/src/features/usage/model/headerRows.ts`
- Modify: `src/renderer/src/features/usage/model/formatUsage.ts` (add `formatResetShort`, refactor `formatReset` to share the bucketing)

**Interfaces:**
- Consumes: `UsageSnapshot`, `UsageProviderSnapshot`, `UsageLimitRow` from `@preload/index` (same import path `UsageModal.tsx` uses).
- Produces (Task 4 consumes verbatim):
  - `formatResetShort(value: string | null): string | null` — `"42m" | "3h" | "4d" | "soon" | null`
  - `type HeaderRow = { id: string; shortLabel: string; percent: number | null; severity: UsageSeverity; resetsAt: string | null }`
  - `type HeaderProvider = { provider: UsageProviderKind; code: string; rows: HeaderRow[]; worst: HeaderRow | null }`
  - `toHeaderProviders(snapshot: UsageSnapshot): HeaderProvider[]`
  - `worstAcross(providers: HeaderProvider[]): HeaderRow | null`
  - `headerTooltip(snapshot: UsageSnapshot, stale: boolean): string`

- [ ] **Step 1: Refactor `formatUsage.ts`** — replace the body of `formatReset` so both functions share one bucketing (DRY; the date math must never drift between modal and header):

```ts
/** Compact reset countdown for the header widget: "42m" / "3h" / "4d" /
 *  "soon". Same bucketing as the modal's formatReset — that function now
 *  delegates here so the two surfaces can never disagree about rounding. */
export function formatResetShort(value: string | null): string | null {
  if (!value) return null
  const ts = Date.parse(value)
  if (!Number.isFinite(ts)) return null
  const deltaMs = ts - Date.now()
  if (deltaMs <= 0) return 'soon'
  const minutes = Math.round(deltaMs / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

export function formatReset(value: string | null): string | null {
  const short = formatResetShort(value)
  if (short === null) return null
  return short === 'soon' ? 'resets soon' : `resets in ${short}`
}
```

- [ ] **Step 2: Create `headerRows.ts`** — complete file:

```ts
import type {
  UsageLimitRow,
  UsageProviderKind,
  UsageSeverity,
  UsageSnapshot,
} from '@preload/index'

import { formatPercent, formatReset, providerLabel } from '@renderer/features/usage/model/formatUsage'

/** Display-only projection of a UsageLimitRow for the header chips.
 *  `id` is passed through untouched — it stays the React key; the short
 *  label is presentation and must never feed back into row identity. */
export type HeaderRow = {
  id: string
  shortLabel: string
  percent: number | null
  severity: UsageSeverity
  resetsAt: string | null
}

export type HeaderProvider = {
  provider: UsageProviderKind
  /** Two-letter chip prefix ("CL" / "CX") — fixed strings, not derived
   *  from providerLabel, because the header needs stable width. */
  code: string
  rows: HeaderRow[]
  /** Highest-percent row, used by the 'minimal' and 'providers' levels.
   *  null when every row has percent: null (unknown can't win "most
   *  constrained" — see spec §3.2). */
  worst: HeaderRow | null
}

/** Header chips can't fit "Current week (all models)". Known label
 *  shapes (see labelClaudeLimit in src/main/usage/claudeUsage.ts and
 *  labelCodexWindow in codexUsage.ts) map to fixed short forms; anything
 *  unrecognized falls back to first-word-max-6-chars so a future
 *  provider label degrades to *something* rather than blowing up the
 *  row. Display-only heuristic — do not use for identity or sorting. */
export function shortRowLabel(label: string): string {
  if (/^current session$/i.test(label)) return 'ses'
  const week = label.match(/^current week \((.+)\)$/i)
  if (week) {
    return /^all models$/i.test(week[1])
      ? 'wk'
      : week[1].toLowerCase().split(/\s+/)[0].slice(0, 6)
  }
  const hours = label.match(/^(\d+)\s*h/i)
  if (hours) return `${hours[1]}h`
  if (/^week/i.test(label)) return 'wk'
  return label.toLowerCase().split(/\s+/)[0].slice(0, 6)
}

function toHeaderRow(row: UsageLimitRow): HeaderRow {
  return {
    id: row.id,
    shortLabel: shortRowLabel(row.label),
    percent: row.percent,
    severity: row.severity,
    resetsAt: row.resetsAt,
  }
}

function worstOf(rows: HeaderRow[]): HeaderRow | null {
  let worst: HeaderRow | null = null
  for (const row of rows) {
    if (row.percent === null) continue
    if (worst === null || row.percent > (worst.percent ?? -1)) worst = row
  }
  return worst
}

/** Errored providers are dropped entirely (their chip is simply absent —
 *  error prose belongs in the modal, spec §3.2), and inactive rows are
 *  excluded at every level: the header shows limits currently in force,
 *  the modal remains the complete view. */
export function toHeaderProviders(snapshot: UsageSnapshot): HeaderProvider[] {
  const result: HeaderProvider[] = []
  for (const provider of snapshot.providers) {
    if (provider.status !== 'ok') continue
    const rows = provider.rows.filter(row => row.active).map(toHeaderRow)
    if (rows.length === 0) continue
    result.push({
      provider: provider.provider,
      code: provider.provider === 'claude' ? 'CL' : 'CX',
      rows,
      worst: worstOf(rows),
    })
  }
  return result
}

export function worstAcross(providers: HeaderProvider[]): HeaderRow | null {
  return worstOf(providers.flatMap(p => (p.worst ? [p.worst] : [])))
}

/** Full detail for the title-attribute tooltip so even 'minimal' exposes
 *  everything on hover: every provider (including errored ones, whose
 *  message only surfaces here), full labels, exact percents, resets. */
export function headerTooltip(snapshot: UsageSnapshot, stale: boolean): string {
  const lines: string[] = []
  for (const provider of snapshot.providers) {
    if (provider.status === 'error') {
      lines.push(`${providerLabel(provider.provider)}: ${provider.message}`)
      continue
    }
    for (const row of provider.rows.filter(r => r.active)) {
      const reset = formatReset(row.resetsAt)
      lines.push(
        `${providerLabel(provider.provider)} ${row.label}: ${formatPercent(row.percent)}${reset ? ` (${reset})` : ''}`,
      )
    }
  }
  if (stale) {
    const fetched = new Date(snapshot.fetchedAt)
    const time = Number.isNaN(fetched.getTime()) ? '?' : fetched.toLocaleTimeString()
    lines.push(`(stale — last updated ${time})`)
  }
  return lines.join('\n')
}
```

- [ ] **Step 3: Verify** — `npx tsc -p tsconfig.web.json --noEmit` → 0 errors. Confirm the modal still compiles against the refactored `formatReset` (it's in the same tsc run).

- [ ] **Step 4: Commit** — `git add -A src/renderer/src/features/usage/model && git commit -m "feat(usage-header): pure header-row model + shared reset bucketing"`

---

### Task 3: Polling hook

**Files:**
- Create: `src/renderer/src/features/usage/hooks/useUsageHeaderSnapshot.ts`

**Interfaces:**
- Consumes: `window.api.getUsageSnapshot(request?)` (preload, already exposed).
- Produces (Task 4 consumes): `useUsageHeaderSnapshot(): { snapshot: UsageSnapshot | null; stale: boolean }`

- [ ] **Step 1: Create the hook** — complete file:

```ts
import { useEffect, useState } from 'react'

import type { UsageSnapshot } from '@preload/index'

/** 60s, not 30s: quota percentages move on multi-minute timescales, and
 *  the main-process cache TTL is 30s (usageService.ts) — polling faster
 *  than the TTL just returns cached snapshots half the time. 60s halves
 *  IPC chatter for zero perceptible staleness, and the shared cache means
 *  header + modal can never stampede the provider APIs (worst case one
 *  real upstream fetch per 30s regardless of consumer count). */
const POLL_INTERVAL_MS = 60_000

/** Polls the usage snapshot for the header widget.
 *
 *  Component-local state, not a store slice: the widget is the only
 *  consumer, and SettingsBar unmounts it when usageHeaderEnabled is off,
 *  which tears down the interval — the disabled feature costs zero.
 *  Promote to zustand only if a second consumer ever appears.
 *
 *  Visibility-gated: this repo has been burned by background polling
 *  before (proxy-events full-file 200ms poll OOM, 2026-07-07; 60Hz
 *  screen-snapshot GC churn). Ambient chrome must not tick in a hidden
 *  window — ticks while hidden are skipped, and re-focus triggers an
 *  immediate refresh so the user never reads a minutes-old number. */
export function useUsageHeaderSnapshot(): { snapshot: UsageSnapshot | null; stale: boolean } {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)
  const [stale, setStale] = useState(false)

  useEffect(() => {
    let disposed = false
    let inFlight = false

    const poll = async () => {
      // In-flight guard: a hung IPC round-trip must not queue a second
      // one behind it (the proxy-events OOM was exactly an unguarded
      // overlapping poll).
      if (inFlight || document.visibilityState === 'hidden') return
      inFlight = true
      try {
        const next = await window.api.getUsageSnapshot({})
        if (!disposed) {
          setSnapshot(next)
          setStale(false)
        }
      } catch {
        // Keep the last good snapshot on failure — never blank working
        // chrome because one poll failed. The widget renders it with a
        // "(stale — ...)" tooltip note instead.
        if (!disposed) setStale(true)
      } finally {
        inFlight = false
      }
    }

    void poll()
    const interval = window.setInterval(() => void poll(), POLL_INTERVAL_MS)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void poll()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  return { snapshot, stale }
}
```

- [ ] **Step 2: Verify** — `npx tsc -p tsconfig.web.json --noEmit` → 0 errors.

- [ ] **Step 3: Commit** — `git add -A src/renderer/src/features/usage/hooks && git commit -m "feat(usage-header): visibility-gated 60s polling hook"`

---

### Task 4: Widget component + SettingsBar mount

**Files:**
- Create: `src/renderer/src/features/usage/ui/UsageHeaderIndicator.tsx`
- Modify: `src/renderer/src/app/shell/SettingsBar.tsx` (chrome group div, lines 29–78)

**Interfaces:**
- Consumes: `useUsageHeaderSnapshot` (Task 3), `toHeaderProviders` / `worstAcross` / `headerTooltip` / `HeaderRow` / `HeaderProvider` (Task 2), `formatResetShort` + `severityTextStyle` / `severityBarStyle` / `formatPercent` (`formatUsage.ts`), `UsageHeaderLevel` (Task 1), `useAppStore(state => state.openUsageModal)`.
- Produces: `UsageHeaderIndicator({ level }: { level: UsageHeaderLevel })` — mounted only by `SettingsBar`.

- [ ] **Step 1: Create `UsageHeaderIndicator.tsx`** — complete file:

```tsx
import { useAppStore } from '@renderer/app-state/hooks'
import type { UsageHeaderLevel } from '@renderer/app-state/settings/types'
import { useUsageHeaderSnapshot } from '@renderer/features/usage/hooks/useUsageHeaderSnapshot'
import {
  headerTooltip,
  toHeaderProviders,
  worstAcross,
  type HeaderProvider,
  type HeaderRow,
} from '@renderer/features/usage/model/headerRows'
import {
  formatPercent,
  formatResetShort,
  severityBarStyle,
  severityTextStyle,
} from '@renderer/features/usage/model/formatUsage'

/** One quota row inside a provider chip. `detailed` adds a ~28px severity
 *  micro-bar and a compact reset ("3h") — everything else is shared so the
 *  four levels can't drift apart visually. */
function RowCell({ row, detailed }: { row: HeaderRow; detailed: boolean }) {
  const width = row.percent === null ? 0 : Math.max(0, Math.min(100, row.percent))
  const reset = detailed ? formatResetShort(row.resetsAt) : null
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-muted">{row.shortLabel}</span>
      {detailed ? (
        <span className="inline-block h-[3px] w-7 overflow-hidden bg-surface-hi align-middle">
          <span
            className="block h-full"
            style={{ width: `${width}%`, ...severityBarStyle(row.severity) }}
          />
        </span>
      ) : null}
      <span style={severityTextStyle(row.severity)}>
        {row.percent === null ? '?%' : formatPercent(row.percent)}
      </span>
      {reset ? <span className="text-muted">{reset}</span> : null}
    </span>
  )
}

function ProviderChip({
  provider,
  level,
}: {
  provider: HeaderProvider
  level: UsageHeaderLevel
}) {
  const rows = level === 'providers' ? (provider.worst ? [provider.worst] : []) : provider.rows
  if (rows.length === 0) return null
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="font-semibold text-ink">{provider.code}</span>
      {rows.map((row, index) => (
        <span key={row.id} className="inline-flex items-center gap-1.5">
          {index > 0 ? <span className="text-muted">·</span> : null}
          <RowCell row={row} detailed={level === 'detailed'} />
        </span>
      ))}
    </span>
  )
}

/** Ambient quota indicator for the SettingsBar. Mounted ONLY while
 *  usageHeaderEnabled is on (SettingsBar gates the mount) — that gating
 *  is what tears down the polling interval, so do not add an internal
 *  enabled check here. Click-through to the modal keeps the header
 *  glanceable: detail, refresh, and error prose all live in the modal. */
export function UsageHeaderIndicator({ level }: { level: UsageHeaderLevel }) {
  const openUsageModal = useAppStore(state => state.openUsageModal)
  const { snapshot, stale } = useUsageHeaderSnapshot()

  // First poll in flight: render nothing. No skeleton flash in chrome —
  // data arrives within ~1s and the bar reflows gracefully.
  if (!snapshot) return null

  const providers = toHeaderProviders(snapshot)
  const worst = worstAcross(providers)
  const tooltip = headerTooltip(snapshot, stale)
  const chipClass = `
    inline-flex items-center gap-2 border border-border bg-surface-hi
    px-2 py-1 text-[10px] font-code leading-none
    transition-colors hover:border-accent cursor-pointer
  `

  // Both providers errored / nothing active: a single muted chip whose
  // tooltip carries the provider error messages (spec §3.2). Still
  // clickable — the modal is where the full error text and refresh live.
  if (providers.length === 0) {
    return (
      <button type="button" onClick={openUsageModal} title={tooltip} className={chipClass}>
        <span className="text-muted">usage n/a</span>
      </button>
    )
  }

  if (level === 'minimal') {
    return (
      <button type="button" onClick={openUsageModal} title={tooltip} className={chipClass}>
        <span className="text-muted">usage</span>
        {worst ? (
          <span style={severityTextStyle(worst.severity)}>{formatPercent(worst.percent)}</span>
        ) : (
          <span className="text-muted">?%</span>
        )}
      </button>
    )
  }

  return (
    <button type="button" onClick={openUsageModal} title={tooltip} className={chipClass}>
      {providers.map((provider, index) => (
        <span key={provider.provider} className="inline-flex items-center gap-2">
          {index > 0 ? <span className="text-muted">│</span> : null}
          <ProviderChip provider={provider} level={level} />
        </span>
      ))}
    </button>
  )
}
```

- [ ] **Step 2: Mount in `SettingsBar.tsx`** — add the import, then inside the `[-webkit-app-region:no-drag]` div, BEFORE `<AppearanceMenu …/>`:

```tsx
        {settings.usageHeaderEnabled ? (
          <UsageHeaderIndicator level={settings.usageHeaderLevel} />
        ) : null}
```

(`settings` is already selected in this component; no new store wiring needed.)

- [ ] **Step 3: Verify** — `npx tsc -p tsconfig.web.json --noEmit` → 0 errors. Then live-check: `npm run dev`, confirm the chip renders left of `appearance`, shows real percentages, and clicking opens the Usage modal.

- [ ] **Step 4: Commit** — `git add -A src/renderer/src/features/usage/ui src/renderer/src/app/shell/SettingsBar.tsx && git commit -m "feat(usage-header): header widget + SettingsBar mount"`

---

### Task 5: Settings-page entries (toggle + level select)

**Files:**
- Modify: `src/renderer/src/features/settings/lib/settingsRegistry.ts` (add after the `worktree-badges` entry, ~line 348)

**Interfaces:**
- Consumes: `Settings.usageHeaderEnabled` / `usageHeaderLevel` / `USAGE_HEADER_LEVELS` (Task 1); registry `SettingDefinition` shapes (toggle at lines 38–48, select at 49–62).

- [ ] **Step 1: Add both entries** (category `workspace`, matching `worktree-badges`):

```ts
    {
      id: 'usage-header',
      category: 'workspace',
      title: 'Usage in Header',
      description:
        'Show Claude and Codex quota usage in the header bar. Click the indicator to open the full Usage modal.',
      keywords: ['usage', 'quota', 'limits', 'header', 'tokens', 'claude', 'codex'],
      control: {
        type: 'toggle',
        getValue: settings => settings.usageHeaderEnabled,
        onToggle: (ctx, value) => ctx.onChange({ usageHeaderEnabled: value }),
      },
    },
    {
      // The registry has no dependent-visibility concept, so this select
      // stays visible while the toggle above is off — it simply has no
      // visible effect until the header is enabled, and the description
      // says so. Modeling enable+level as one 5-option select was
      // rejected: the palette needs a plain on/off toggle command, and
      // splitting keeps setting↔command mappings 1:1.
      id: 'usage-header-level',
      category: 'workspace',
      title: 'Usage Header Detail',
      description:
        'How much detail the header usage indicator shows (no effect while Usage in Header is off).',
      keywords: ['usage', 'quota', 'level', 'detail', 'header'],
      control: {
        type: 'select',
        getValue: settings => settings.usageHeaderLevel,
        options: [
          { value: 'minimal', label: 'Minimal', description: 'Single worst-case percentage across both providers.' },
          { value: 'providers', label: 'Providers', description: 'One chip per provider showing its most constrained limit.' },
          { value: 'all', label: 'All limits', description: 'Every active limit row per provider, compact labels.' },
          { value: 'detailed', label: 'Detailed', description: 'All limits plus severity bars and reset countdowns.' },
        ],
        onSelect: (ctx, value) =>
          ctx.onChange({ usageHeaderLevel: value as Settings['usageHeaderLevel'] }),
      },
    },
```

- [ ] **Step 2: Verify** — `npx tsc -p tsconfig.web.json --noEmit` → 0 errors. Live-check in `npm run dev`: Settings → Workspace shows both entries; toggling hides/shows the chip immediately; each level changes the chip live.

- [ ] **Step 3: Commit** — `git add -A src/renderer/src/features/settings && git commit -m "feat(usage-header): settings page toggle + detail-level select"`

---

### Task 6: Palette commands + flags/ui plumbing

**Files:**
- Modify: `src/renderer/src/app-state/types.ts` (SettingsSlice, ~line 18)
- Modify: `src/renderer/src/app-state/settings/slice.ts` (after `toggleWorktreeBadges`, line 63)
- Modify: `src/renderer/src/features/command-palette/types.ts` (ui block ends ~line 154; flags block lines 156–212)
- Modify: `src/renderer/src/features/command-palette/ui/CommandPalette.tsx` (selector block ~line 131, flags derivation ~line 165, ui object ~line 384, flags object ~line 400, memo dep arrays ~lines 464/478)
- Modify: `src/renderer/src/features/usage/commands/usageCommands.ts`

**Interfaces:**
- Consumes: `USAGE_HEADER_LEVELS`, `UsageHeaderLevel` (Task 1).
- Produces: store actions `toggleUsageHeader(): void`, `cycleUsageHeaderLevel(): void`; `CommandContext.ui.toggleUsageHeader` / `ui.cycleUsageHeaderLevel`; `CommandContext.flags.usageHeaderEnabled: boolean` / `flags.usageHeaderLevel: UsageHeaderLevel`; commands `usage.toggle-header`, `usage.cycle-header-level`.

- [ ] **Step 1: Store actions.** In `app-state/types.ts` SettingsSlice add:

```ts
  toggleUsageHeader: () => void
  cycleUsageHeaderLevel: () => void
```

In `app-state/settings/slice.ts` add after `toggleWorktreeBadges` (import `USAGE_HEADER_LEVELS` from `./types`):

```ts
  toggleUsageHeader: () =>
    set(state => {
      const next = {
        ...state.settings,
        usageHeaderEnabled: !state.settings.usageHeaderEnabled,
      }
      applyTheme(next)
      return { settings: next }
    }, false, 'settings/toggleUsageHeader'),
  cycleUsageHeaderLevel: () =>
    set(state => {
      const index = USAGE_HEADER_LEVELS.indexOf(state.settings.usageHeaderLevel)
      const next = {
        ...state.settings,
        // Circular walk of the canonical order (types.ts owns it).
        usageHeaderLevel:
          USAGE_HEADER_LEVELS[(index + 1) % USAGE_HEADER_LEVELS.length],
        // Cycling while hidden also enables the header: a user reaching
        // for "more usage detail" obviously wants the widget visible —
        // silently rotating an invisible setting would look like the
        // command does nothing.
        usageHeaderEnabled: true,
      }
      applyTheme(next)
      return { settings: next }
    }, false, 'settings/cycleUsageHeaderLevel'),
```

(The `applyTheme(next)` call matches every sibling toggle in this file — it's the slice-wide pattern, harmless for non-theme keys.)

- [ ] **Step 2: Command context types.** In `command-palette/types.ts`: add to the ui block (after `toggleWorktreeBadges: () => void`):

```ts
    toggleUsageHeader: () => void
    cycleUsageHeaderLevel: () => void
```

and to the flags block (after `worktreeBadgesEnabled: boolean`; add `UsageHeaderLevel` to the existing settings-types import next to `AgentViewMode`):

```ts
    usageHeaderEnabled: boolean
    usageHeaderLevel: UsageHeaderLevel
```

- [ ] **Step 3: Thread through `CommandPalette.tsx`** (follow the `toggleWorktreeBadges` / `worktreeBadgesEnabled` pattern at each site):
  - selector block: `const toggleUsageHeader = useAppStore(state => state.toggleUsageHeader)` and `const cycleUsageHeaderLevel = useAppStore(state => state.cycleUsageHeaderLevel)`
  - flags derivation: `const usageHeaderEnabled = settings.usageHeaderEnabled` and `const usageHeaderLevel = settings.usageHeaderLevel`
  - ui object literal: add `toggleUsageHeader,` and `cycleUsageHeaderLevel,`
  - flags object literal: add `usageHeaderEnabled,` and `usageHeaderLevel,`
  - BOTH memo dependency arrays: add all four identifiers. Missing a dep array entry is the classic silent-staleness bug here — the palette would show "Off" after toggling.

- [ ] **Step 4: Commands.** In `features/usage/commands/usageCommands.ts` append to the array:

```ts
  {
    id: 'usage.toggle-header',
    surface: 'app',
    title: 'Usage in Header',
    description:
      '**What it does:** Shows or hides **provider usage** in the header bar.\n\n**Use when:** You want quota headroom visible while planning agent work.\n\n**Notes:** Click the header indicator to open the full Usage modal.',
    keywords: ['usage', 'quota', 'header', 'limits', 'tokens', 'claude', 'codex'],
    getState: ({ flags }) => ({
      label: flags.usageHeaderEnabled ? 'On' : 'Off',
      tone: flags.usageHeaderEnabled ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.toggleUsageHeader(),
  },
  {
    id: 'usage.cycle-header-level',
    surface: 'app',
    title: 'Usage Header Detail',
    description:
      '**What it does:** Cycles the header usage indicator through **minimal → providers → all → detailed**.\n\n**Use when:** You want more or less quota detail in the header.\n\n**Notes:** Also enables the header indicator if it is currently hidden.',
    keywords: ['usage', 'quota', 'level', 'detail', 'cycle', 'header'],
    getState: ({ flags }) => ({
      label: flags.usageHeaderLevel,
      tone: flags.usageHeaderEnabled ? 'accent' : 'neutral',
    }),
    run: ({ ui }) => ui.cycleUsageHeaderLevel(),
  },
```

- [ ] **Step 5: Verify** — `npx tsc -p tsconfig.web.json --noEmit` → 0 errors (this catches any `CommandContext` site that now fails to provide the new ui/flags members).

- [ ] **Step 6: Commit** — `git add -A src/renderer/src && git commit -m "feat(usage-header): palette toggle + level-cycle commands"`

---

### Task 7: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full type gate** — from the worktree root:

```bash
npx tsc -p tsconfig.node.json; npx tsc -p tsconfig.web.json --noEmit
```

Expected: node project shows ONLY the pre-existing `electron.vite.config.ts` TS2769; web project 0 errors.

- [ ] **Step 2: Test suite (the one full run)** — `NODE_ENV=test npx vitest run`. Expected: same pass/fail set as `main` (`hotkeyBinding.test.ts` failure is pre-existing; nothing new may fail).

- [ ] **Step 3: Live verification in `npm run dev`** — walk the whole surface:
  1. Header chip visible on boot (default on, level `all`), real percentages, severity colors.
  2. Hover → tooltip lists full labels + resets. Click → Usage modal opens.
  3. Palette → "Usage in Header" shows On; run it → chip disappears, state flips to Off.
  4. Palette → "Usage Header Detail" → run 4× → chip reappears (auto-enable) and walks providers → all → detailed → minimal.
  5. Settings → Workspace → both entries present; select each level and watch the chip change live.
  6. Reload the app → toggle + level persist.

- [ ] **Step 4: Commit any doc touch-ups, then stop** — per standing rule, open a PR but do NOT merge it.
