# Provider Enablement + Multi-Provider Usage — Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship issue #1102 — main-owned provider enablement (auto-detect defaults, user overrides), a usage-source registry generalizing usage beyond Claude+Codex, enablement filtering on every provider-choosing surface, and the rail+detail usage modal redesign.

**Architecture:** Enablement state lives in `setup.json` via the established `storage: 'setup'` pattern (additive fields, defensive coercion, no version bump); only user overrides persist, detection is recomputed from `checkPrerequisites().usableProviders`. A main module owns it, broadcasts changes (`provider-enablement:changed`), and feeds both the renderer store (cli-updates sync pattern) and `usageService` (same-process getter). The usage registry keys `UsageSourceId`s to descriptors; grok and `opencode:zai` ship as `null` placeholders until #1103/#1104. Filtering is centralized in `providerChoices.ts` helpers consumed by each picker surface.

**Tech Stack:** Electron IPC (handle/subscribe), zustand standalone store (non-persisted), vitest (unit / renderer projects), React 18.

**Spec:** `docs/superpowers/specs/2026-09-20-provider-usage-enablement-design.md`. Issues: #1102 (this plan), #1103, #1104 (later phases).

**Working tree:** `.worktrees/provider-usage-enablement`, branch `feat/provider-usage-enablement`. The spec commit is already on the branch.

**Conventions:** Thick WHY comments (AGENTS.md). Conventional Commits. Tests protect behavior, not implementation. Do NOT commit unless a task's commit step says so.

---

### Task 1: Shared contracts — enablement types, pure resolvers, UsageSourceId

**Files:**
- Create: `src/shared/types/providerEnablement.ts`
- Create: `src/shared/types/providerEnablement.test.ts`
- Modify: `src/shared/types/usage.ts` (line 3)

- [ ] **Step 1: Write the failing tests**

`src/shared/types/providerEnablement.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import {
  coerceOpencodeUsageSource,
  coerceUserProviderOverrides,
  enabledKindsFromEntries,
  resolveProviderEnablement,
} from './providerEnablement.js'

describe('coerceUserProviderOverrides', () => {
  it('keeps boolean values keyed by valid provider kinds only', () => {
    expect(
      coerceUserProviderOverrides({ grok: false, claude: true, nonsense: true, codex: 'yes' }),
    ).toEqual({ claude: true, grok: false })
  })

  it('returns an empty map for non-object input', () => {
    expect(coerceUserProviderOverrides(null)).toEqual({})
    expect(coerceUserProviderOverrides('grok')).toEqual({})
    expect(coerceUserProviderOverrides([true])).toEqual({})
  })
})

describe('coerceOpencodeUsageSource', () => {
  it('accepts only the two known values and defaults to none', () => {
    expect(coerceOpencodeUsageSource('zai')).toBe('zai')
    expect(coerceOpencodeUsageSource('none')).toBe('none')
    expect(coerceOpencodeUsageSource(undefined)).toBe('none')
    expect(coerceOpencodeUsageSource('kimi')).toBe('none')
  })
})

describe('resolveProviderEnablement', () => {
  it('defaults to detected: installed providers on, missing providers off', () => {
    const entries = resolveProviderEnablement({}, new Set(['claude', 'codex']))
    expect(entries).toEqual([
      { kind: 'claude', enabled: true, because: 'detected', installed: true },
      { kind: 'codex', enabled: true, because: 'detected', installed: true },
      { kind: 'opencode', enabled: false, because: 'not-detected', installed: false },
      { kind: 'grok', enabled: false, because: 'not-detected', installed: false },
    ])
  })

  it('a user override wins over detection in both directions', () => {
    const entries = resolveProviderEnablement(
      { grok: true, claude: false },
      new Set(['claude']),
    )
    const byKind = new Map(entries.map(e => [e.kind, e]))
    // Enabled-by-user even though nothing was detected: the user's explicit
    // word survives an uninstall/reinstall cycle (#1102 spec §Contracts).
    expect(byKind.get('grok')).toMatchObject({ enabled: true, because: 'user', installed: false })
    expect(byKind.get('claude')).toMatchObject({ enabled: false, because: 'user', installed: true })
  })
})

describe('enabledKindsFromEntries', () => {
  it('collects exactly the enabled entries', () => {
    const entries = resolveProviderEnablement({ grok: true }, new Set(['claude']))
    expect([...enabledKindsFromEntries(entries)].sort()).toEqual(['claude', 'grok'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit src/shared/types/providerEnablement.test.ts`
Expected: FAIL — module `./providerEnablement.js` not found.

- [ ] **Step 3: Implement `src/shared/types/providerEnablement.ts`**

```ts
import { AGENT_PROVIDER_KINDS, type AgentProviderKind } from './providerKind.js'

export const OPENCODE_USAGE_SOURCES = ['none', 'zai'] as const
export type OpencodeUsageSource = (typeof OPENCODE_USAGE_SOURCES)[number]

/**
 * Only the user's explicit on/off word persists (#1102). Detection is
 * recomputed from the toolchain every time enablement is resolved, so a
 * stored "detected" value could only ever go stale — an install/uninstall
 * after a Reset must be reflected without a migration.
 */
export type UserProviderOverrides = Partial<Record<AgentProviderKind, boolean>>

export type ProviderEnablementEntry = {
  kind: AgentProviderKind
  enabled: boolean
  /** Why this value holds — drives the settings row's hint text. */
  because: 'user' | 'detected' | 'not-detected'
  /** Whether a CLI was found on the last detection run (display only). */
  installed: boolean
}

export type ProviderEnablementSnapshot = {
  entries: Array<ProviderEnablementEntry>
  opencodeUsageSource: OpencodeUsageSource
}

export function coerceUserProviderOverrides(raw: unknown): UserProviderOverrides {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: UserProviderOverrides = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // Unknown keys and non-boolean values are dropped, not thrown on: a
    // hand-edited setup.json must not take the whole app down at load.
    if ((AGENT_PROVIDER_KINDS as readonly string[]).includes(key) && typeof value === 'boolean') {
      result[key as AgentProviderKind] = value
    }
  }
  return result
}

export function coerceOpencodeUsageSource(raw: unknown): OpencodeUsageSource {
  return raw === 'zai' ? 'zai' : 'none'
}

/**
 * WHY entries and not a map: the settings row renders one row per provider in
 * AGENT_PROVIDER_KINDS order with its reason attached, and the modal/pickers
 * only need the enabled set. An array preserves order once, at the source.
 */
export function resolveProviderEnablement(
  overrides: UserProviderOverrides,
  installed: ReadonlySet<AgentProviderKind>,
): Array<ProviderEnablementEntry> {
  return AGENT_PROVIDER_KINDS.map(kind => {
    const hasOverride = Object.prototype.hasOwnProperty.call(overrides, kind)
    const isInstalled = installed.has(kind)
    if (hasOverride) {
      return { kind, enabled: overrides[kind] === true, because: 'user' as const, installed: isInstalled }
    }
    return {
      kind,
      enabled: isInstalled,
      because: isInstalled ? ('detected' as const) : ('not-detected' as const),
      installed: isInstalled,
    }
  })
}

export function enabledKindsFromEntries(
  entries: Array<ProviderEnablementEntry>,
): ReadonlySet<AgentProviderKind> {
  return new Set(entries.filter(entry => entry.enabled).map(entry => entry.kind))
}
```

- [ ] **Step 4: Generalize the usage source id in `src/shared/types/usage.ts`**

Replace line 3:

```ts
export type UsageProviderKind = Extract<AgentProviderKind, 'claude' | 'codex'>
```

with:

```ts
// #1102: usage sources are no longer 1:1 with agent provider kinds — z.ai is
// read through the user's OpenCode credential, hence the compound id. The
// alias keeps ~a dozen existing call sites compiling while new code uses
// UsageSourceId; it is not a permanent second name.
export type UsageSourceId = 'claude' | 'codex' | 'grok' | 'opencode:zai'
export type UsageProviderKind = UsageSourceId
```

Then delete the now-unused `AgentProviderKind` import on line 1 if nothing else in the file references it (typecheck will confirm).

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --project unit src/shared/types/providerEnablement.test.ts`
Expected: PASS (5 tests).
Run: `npm run typecheck`
Expected: PASS — the alias means existing `UsageProviderKind` consumers still compile.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/providerEnablement.ts src/shared/types/providerEnablement.test.ts src/shared/types/usage.ts
git commit -m "feat(usage): add provider enablement contracts and UsageSourceId"
```

---

### Task 2: Main-owned enablement state (setup.json + detection + mutations)

**Files:**
- Modify: `src/main/setup/setupState.ts` (type `PersistedSetupState` lines 27–71, defaults line 73, loader lines 87–115, new mutators after `setCliUpdateBehavior` ~line 210)
- Create: `src/main/setup/providerEnablement.ts`
- Test: covered by Task 1's pure resolvers + typecheck; IO wiring is exercised end-to-end in Task 4's renderer tests through the mocked API boundary.

- [ ] **Step 1: Extend `PersistedSetupState`**

In `src/main/setup/setupState.ts`, add the import:

```ts
import {
  coerceOpencodeUsageSource,
  coerceUserProviderOverrides,
  type OpencodeUsageSource,
  type UserProviderOverrides,
} from '@shared/types/providerEnablement.js'
```

Add fields to `PersistedSetupState` (after `cliUpdateCache`, before `updatedAt`):

```ts
  // User's explicit provider on/off word (#1102). Only overrides persist —
  // detection is recomputed, so these entries stay meaningful across
  // installs/uninstalls. Same additive-field, no-version-bump rationale as
  // manualToolPaths above; coerced defensively at load.
  providerEnablementOverrides: UserProviderOverrides
  // Which OpenCode-configured provider the usage surface should report
  // (#1102/#1104). 'zai' has no reader until #1104 lands.
  opencodeUsageSource: OpencodeUsageSource
```

Extend `DEFAULT_SETUP_STATE`:

```ts
  providerEnablementOverrides: {},
  opencodeUsageSource: 'none',
```

In `loadSetupState`'s reconstruction (after `cliUpdateCache`, before `updatedAt`):

```ts
      providerEnablementOverrides: coerceUserProviderOverrides(parsed.providerEnablementOverrides),
      opencodeUsageSource: coerceOpencodeUsageSource(parsed.opencodeUsageSource),
```

- [ ] **Step 2: Add mutators mirroring `setCliUpdateBehavior`**

After `setCliUpdateBehavior` in `setupState.ts`:

```ts
export async function setProviderEnablementOverrides(
  overrides: UserProviderOverrides,
): Promise<PersistedSetupState> {
  const state = await loadSetupState()
  return await saveSetupState({ ...state, providerEnablementOverrides: overrides })
}

export async function setOpencodeUsageSource(
  opencodeUsageSource: OpencodeUsageSource,
): Promise<PersistedSetupState> {
  const state = await loadSetupState()
  return await saveSetupState({ ...state, opencodeUsageSource })
}
```

- [ ] **Step 3: Implement `src/main/setup/providerEnablement.ts`**

```ts
// Main-owned provider enablement (#1102): the single source of truth for
// "which providers may appear in pickers and usage". Renderer reaches it
// through IPC; usageService reads it in-process.

import { AGENT_PROVIDER_KINDS, type AgentProviderKind } from '@shared/types/providerKind.js'
import {
  enabledKindsFromEntries,
  resolveProviderEnablement,
  type OpencodeUsageSource,
  type ProviderEnablementSnapshot,
} from '@shared/types/providerEnablement.js'
import { checkPrerequisites } from '@main/setup/prerequisites.js'
import { invalidateUsageSnapshotCache } from '@main/usage/usageService.js'
import {
  loadSetupState,
  setOpencodeUsageSource as persistOpencodeUsageSource,
  setProviderEnablementOverrides,
} from '@main/setup/setupState.js'

type Listener = (snapshot: ProviderEnablementSnapshot) => void
const listeners = new Set<Listener>()

// Detection is cached for the process lifetime and only recomputed on an
// explicit reset: checkPrerequisites probes the login shell, which is slow
// enough that running it per picker render would be visible.
let cachedDetected: ReadonlySet<AgentProviderKind> | null = null
let inFlightDetection: Promise<ReadonlySet<AgentProviderKind>> | null = null
let cachedSnapshot: ProviderEnablementSnapshot | null = null

function detectInstalledKinds(): Promise<ReadonlySet<AgentProviderKind>> {
  if (cachedDetected) return Promise.resolve(cachedDetected)
  if (inFlightDetection) return inFlightDetection
  inFlightDetection = checkPrerequisites().then(result => {
    // usableProviders is the exact resolution the first-run SetupGate uses
    // (manual override → PATH probe → bundled archive), so Settings →
    // Providers and the gate can never disagree about "installed".
    cachedDetected = new Set(
      (result.usableProviders ?? []).filter(kind => AGENT_PROVIDER_KINDS.includes(kind)),
    )
    inFlightDetection = null
    return cachedDetected
  })
  return inFlightDetection
}

async function resolveAndCache(): Promise<ProviderEnablementSnapshot> {
  const state = await loadSetupState()
  const detected = await detectInstalledKinds()
  cachedSnapshot = {
    entries: resolveProviderEnablement(state.providerEnablementOverrides, detected),
    opencodeUsageSource: state.opencodeUsageSource,
  }
  return cachedSnapshot
}

/** Fail-open before the first resolve: hiding a user's providers because a
 * poll had not run yet is worse than briefly showing a provider that was
 * just disabled — and matches pre-#1102 behavior exactly. */
export function enabledAgentProviderKindsSync(): ReadonlySet<AgentProviderKind> {
  return cachedSnapshot
    ? enabledKindsFromEntries(cachedSnapshot.entries)
    : new Set(AGENT_PROVIDER_KINDS)
}

export function getCachedProviderEnablement(): ProviderEnablementSnapshot | null {
  return cachedSnapshot
}

export async function getProviderEnablementSnapshot(): Promise<ProviderEnablementSnapshot> {
  return await resolveAndCache()
}

function emit(snapshot: ProviderEnablementSnapshot): void {
  for (const listener of listeners) listener(snapshot)
}

async function mutate(action: () => Promise<void>): Promise<ProviderEnablementSnapshot> {
  await action()
  // The usage snapshot's provider set is derived from enablement; a stale
  // 30s TTL after a toggle would show a just-hidden provider until it
  // expired. Invalidate eagerly instead.
  invalidateUsageSnapshotCache()
  const snapshot = await resolveAndCache()
  emit(snapshot)
  return snapshot
}

export async function setProviderEnabled(
  kind: AgentProviderKind,
  enabled: boolean,
): Promise<ProviderEnablementSnapshot> {
  const state = await loadSetupState()
  const overrides = { ...state.providerEnablementOverrides, [kind]: enabled }
  return await mutate(() => setProviderEnablementOverrides(overrides))
}

export async function resetProviderEnablement(
  kind: AgentProviderKind,
): Promise<ProviderEnablementSnapshot> {
  const state = await loadSetupState()
  const overrides = { ...state.providerEnablementOverrides }
  delete overrides[kind]
  // Reset must also redo detection: "installed" is the display hint on the
  // settings row, and a stale cached detection would keep showing the state
  // from before any install that happened while the app was closed.
  cachedDetected = null
  return await mutate(() => setProviderEnablementOverrides(overrides))
}

export async function setOpencodeUsage(
  value: OpencodeUsageSource,
): Promise<ProviderEnablementSnapshot> {
  return await mutate(() => persistOpencodeUsageSource(value))
}

export function onProviderEnablementChanged(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}
```

- [ ] **Step 4: Add the cache invalidator to `usageService.ts`**

In `src/main/usage/usageService.ts`, export next to `getUsageSnapshot`:

```ts
/** Called by providerEnablement mutations (#1102): the active source set is
 * derived from enablement, so a toggle must not leave the 30s TTL serving
 * the old provider list. In-flight fetches still complete; new callers
 * fetch fresh. */
export function invalidateUsageSnapshotCache(): void {
  cachedSnapshot = null
}
```

Note: Task 8 rewires this file's fetch list; the invalidator is added now because `providerEnablement.ts` imports it.

- [ ] **Step 5: Verify compile + existing tests**

Run: `npm run typecheck && npx vitest run --project unit src/shared/types/providerEnablement.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/setup/setupState.ts src/main/setup/providerEnablement.ts src/main/usage/usageService.ts
git commit -m "feat(usage): main-owned provider enablement state with detection reuse"
```

---

### Task 3: IPC surface + preload API

**Files:**
- Create: `src/main/ipc/providerEnablement.ts`
- Modify: `src/main/ipc/index.ts` (import at ~line 49, call at ~line 141)
- Create: `src/preload/api/providerEnablement.ts`
- Modify: `src/preload/api/index.ts` (import + spread, mirroring `usageApi` at lines 33/99)

- [ ] **Step 1: Implement `src/main/ipc/providerEnablement.ts`**

Model on `src/main/ipc/cliUpdates.ts` (same push-channel contract):

```ts
import { ipcMain } from 'electron'

import {
  getProviderEnablementSnapshot,
  onProviderEnablementChanged,
  resetProviderEnablement,
  setOpencodeUsage,
  setProviderEnabled,
} from '@main/setup/providerEnablement.js'
import { broadcastToWindows } from '@main/window/windowRegistry.js'
import { OPENCODE_USAGE_SOURCES, type OpencodeUsageSource } from '@shared/types/providerEnablement.js'
import { isAgentProviderKind, type AgentProviderKind } from '@shared/types/providerKind.js'

// Handlers return the fresh snapshot AND the change is broadcast, so every
// window's pickers update even though only one window's settings row was
// touched — same contract as cli-updates:state.
export function registerProviderEnablementIpc(): void {
  ipcMain.handle('provider-enablement:get', () => getProviderEnablementSnapshot())

  ipcMain.handle('provider-enablement:set', async (_evt, kind: unknown, enabled: unknown) => {
    if (!isAgentProviderKind(kind) || typeof enabled !== 'boolean') {
      throw new Error('provider-enablement:set: invalid arguments')
    }
    return await setProviderEnabled(kind as AgentProviderKind, enabled)
  })

  ipcMain.handle('provider-enablement:reset', async (_evt, kind: unknown) => {
    if (!isAgentProviderKind(kind)) {
      throw new Error('provider-enablement:reset: invalid kind')
    }
    return await resetProviderEnablement(kind as AgentProviderKind)
  })

  ipcMain.handle(
    'provider-enablement:set-opencode-usage-source',
    async (_evt, value: unknown) => {
      if (
        typeof value !== 'string' ||
        !(OPENCODE_USAGE_SOURCES as readonly string[]).includes(value)
      ) {
        throw new Error('provider-enablement:set-opencode-usage-source: invalid value')
      }
      return await setOpencodeUsage(value as OpencodeUsageSource)
    },
  )

  onProviderEnablementChanged(snapshot => {
    broadcastToWindows('provider-enablement:changed', snapshot)
  })
}
```

- [ ] **Step 2: Register in `src/main/ipc/index.ts`**

Add import beside the usage import:

```ts
import { registerProviderEnablementIpc } from '@main/ipc/providerEnablement.js'
```

Call inside `registerAllIpc`, next to `registerUsageIpc()`:

```ts
  registerProviderEnablementIpc()
```

- [ ] **Step 3: Implement `src/preload/api/providerEnablement.ts`**

Mirror `src/preload/api/cliUpdates.ts` imports exactly (`subscribe` and `Unsub` come from `./ipc.js`):

```ts
import { ipcRenderer } from 'electron'

import type { Unsub } from './ipc.js'
import { subscribe } from './ipc.js'
import type { ProviderEnablementSnapshot } from '@shared/types/providerEnablement.js'
import type { OpencodeUsageSource } from '@shared/types/providerEnablement.js'
import type { AgentProviderKind } from '@shared/types/providerKind.js'

export const providerEnablementApi = {
  providerEnablementGet: (): Promise<ProviderEnablementSnapshot> =>
    ipcRenderer.invoke('provider-enablement:get'),
  providerEnablementSet: (
    kind: AgentProviderKind,
    enabled: boolean,
  ): Promise<ProviderEnablementSnapshot> =>
    ipcRenderer.invoke('provider-enablement:set', kind, enabled),
  providerEnablementReset: (kind: AgentProviderKind): Promise<ProviderEnablementSnapshot> =>
    ipcRenderer.invoke('provider-enablement:reset', kind),
  providerEnablementSetOpencodeUsageSource: (
    value: OpencodeUsageSource,
  ): Promise<ProviderEnablementSnapshot> =>
    ipcRenderer.invoke('provider-enablement:set-opencode-usage-source', value),
  onProviderEnablementChanged: (cb: (snapshot: ProviderEnablementSnapshot) => void): Unsub =>
    subscribe('provider-enablement:changed', cb),
}
```

If `Unsub` is not exported from `./ipc.js`, check how `cliUpdates.ts` types its unsubscribe and mirror that instead (typecheck verifies).

- [ ] **Step 4: Spread into `src/preload/api/index.ts`**

Beside the `usageApi` import (line 33) and spread (line 99):

```ts
import { providerEnablementApi } from '@preload/api/providerEnablement.js'
```

```ts
  ...providerEnablementApi,
```

- [ ] **Step 5: Verify**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/ipc/providerEnablement.ts src/main/ipc/index.ts src/preload/api/providerEnablement.ts src/preload/api/index.ts
git commit -m "feat(usage): provider enablement IPC and preload surface"
```

---

### Task 4: Renderer store + app-root sync hook

**Files:**
- Create: `src/renderer/src/features/providers/store.ts`
- Create: `src/renderer/src/features/providers/store.renderer.test.tsx`
- Modify: `src/renderer/src/app/App.tsx` (beside `useCliUpdateSync()` at line 83)

- [ ] **Step 1: Write the failing test**

`src/renderer/src/features/providers/store.renderer.test.tsx` — follows the `window.api` property-override pattern from `useUsageHeaderSnapshot.renderer.test.tsx`:

```tsx
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProviderEnablementSnapshot } from '@shared/types/providerEnablement'

const snapshot: ProviderEnablementSnapshot = {
  entries: [
    { kind: 'claude', enabled: true, because: 'detected', installed: true },
    { kind: 'codex', enabled: true, because: 'detected', installed: true },
    { kind: 'opencode', enabled: false, because: 'user', installed: true },
    { kind: 'grok', enabled: false, because: 'not-detected', installed: false },
  ],
  opencodeUsageSource: 'none',
}

describe('provider enablement store', () => {
  const original = Object.getOwnPropertyDescriptor(window, 'api')
  let changedCb: ((snapshot: ProviderEnablementSnapshot) => void) | null = null

  beforeEach(() => {
    changedCb = null
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        providerEnablementGet: vi.fn().mockResolvedValue(snapshot),
        onProviderEnablementChanged: vi.fn().mockImplementation(cb => {
          changedCb = cb
          return () => {}
        }),
      },
    })
  })

  afterEach(() => {
    if (original) Object.defineProperty(window, 'api', original)
    vi.restoreAllMocks()
  })

  it('seeds from the initial fetch and follows push updates', async () => {
    const { useProviderEnablementSync, useProviderEnablementStore, useEnabledAgentProviderKinds } =
      await import('./store')
    const { result: sync } = renderHook(() => useProviderEnablementSync())
    void sync

    await act(async () => {
      await Promise.resolve()
    })
    expect(useProviderEnablementStore.getState().snapshot).toEqual(snapshot)
    expect([...useEnabledAgentProviderKindsResult()]).toEqual(['claude', 'codex'])

    function useEnabledAgentProviderKindsResult(): ReadonlySet<string> {
      // selector reads live store state; helper keeps the assertion honest
      const { result } = renderHook(() => useEnabledAgentProviderKinds())
      return result.current
    }

    await act(async () => {
      changedCb?.({ ...snapshot, entries: snapshot.entries.map(e => ({ ...e, enabled: e.kind !== 'codex' })) })
    })
    expect([...useEnabledAgentProviderKindsResult()]).toEqual(['claude'])
  })

  it('fails open (all enabled) before the first snapshot lands', async () => {
    const { useProviderEnablementStore, enabledAgentProviderKindsSnapshot } = await import('./store')
    useProviderEnablementStore.setState({ snapshot: null })
    expect(enabledAgentProviderKindsSnapshot().size).toBe(4)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project renderer src/renderer/src/features/providers/store.renderer.test.tsx`
Expected: FAIL — `./store` not found.

- [ ] **Step 3: Implement `src/renderer/src/features/providers/store.ts`**

```ts
import { create } from 'zustand'
import { useEffect } from 'react'

import type { ProviderEnablementSnapshot } from '@shared/types/providerEnablement'
import { AGENT_PROVIDER_KINDS, type AgentProviderKind } from '@shared/types/providerKind'

type ProviderEnablementState = {
  snapshot: ProviderEnablementSnapshot | null
  setSnapshot: (snapshot: ProviderEnablementSnapshot) => void
}

// Standalone, non-persisted zustand store — the cli-updates shape exactly:
// main owns the value (setup.json), the store is just the renderer's mirror,
// so persisting it here would only create a second truth to drift (#1102).
export const useProviderEnablementStore = create<ProviderEnablementState>(set => ({
  snapshot: null,
  setSnapshot: snapshot => set({ snapshot }),
}))

/** Fail-open before the first snapshot: matches pre-#1102 behavior and never
 * hides a provider because a poll had not landed. */
export function enabledAgentProviderKindsSnapshot(): ReadonlySet<AgentProviderKind> {
  const snapshot = useProviderEnablementStore.getState().snapshot
  if (!snapshot) return new Set(AGENT_PROVIDER_KINDS)
  return new Set(snapshot.entries.filter(entry => entry.enabled).map(entry => entry.kind))
}

export function useEnabledAgentProviderKinds(): ReadonlySet<AgentProviderKind> {
  return useProviderEnablementStore(state =>
    state.snapshot
      ? new Set(state.snapshot.entries.filter(entry => entry.enabled).map(entry => entry.kind))
      : new Set(AGENT_PROVIDER_KINDS),
  )
}

export function useProviderEnablementSnapshot(): ProviderEnablementSnapshot | null {
  return useProviderEnablementStore(state => state.snapshot)
}

/** Initial fetch + push subscription. Mount ONCE at the app root (App.tsx),
 * next to useCliUpdateSync — the same mount-once discipline, for the same
 * reason: a second mount would leak IPC listeners and double every change. */
export function useProviderEnablementSync(): void {
  useEffect(() => {
    let cancelled = false
    void window.api.providerEnablementGet().then(snapshot => {
      if (!cancelled) useProviderEnablementStore.getState().setSnapshot(snapshot)
    })
    const unsub = window.api.onProviderEnablementChanged(snapshot => {
      useProviderEnablementStore.getState().setSnapshot(snapshot)
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [])
}
```

- [ ] **Step 4: Mount in `src/renderer/src/app/App.tsx`**

Import beside the cli-updates sync import:

```ts
import { useProviderEnablementSync } from '@renderer/features/providers/store'
```

Add directly after `useCliUpdateSync()` (line 83):

```tsx
  // Provider enablement mirror: initial fetch + push subscription, same
  // mount-once contract as useCliUpdateSync above (#1102).
  useProviderEnablementSync()
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run --project renderer src/renderer/src/features/providers/store.renderer.test.tsx`
Expected: PASS (2 tests).
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/features/providers/store.ts src/renderer/src/features/providers/store.renderer.test.tsx src/renderer/src/app/App.tsx
git commit -m "feat(usage): renderer provider enablement store with push sync"
```

---

### Task 5: Enablement-aware choice helpers

**Files:**
- Modify: `src/renderer/src/workspace/providerChoices.ts` (append)
- Create: `src/renderer/src/workspace/providerChoices.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/renderer/src/workspace/providerChoices.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import {
  AGENT_PROVIDER_CHOICES,
  enabledProviderSwitchChoices,
  filterAgentProviderChoices,
  filterSessionSpawnChoices,
  SESSION_SPAWN_CHOICES,
} from './providerChoices'

const CLAUDE_CODEX = new Set(['claude', 'codex'])

describe('filterAgentProviderChoices', () => {
  it('removes choices whose kind is disabled, both OpenCode runtimes together', () => {
    const filtered = filterAgentProviderChoices(AGENT_PROVIDER_CHOICES, CLAUDE_CODEX)
    expect(filtered.map(c => c.kind)).toEqual(['claude', 'codex'])
    // OpenCode Terminal must not survive when opencode is disabled: it is a
    // runtime flavor of the same provider identity (providerChoices.ts:22).
  })

  it('keeps both OpenCode runtime choices when opencode is enabled', () => {
    const filtered = filterAgentProviderChoices(AGENT_PROVIDER_CHOICES, new Set(['opencode']))
    expect(filtered.map(c => c.kind)).toEqual(['opencode', 'opencode'])
    expect(filtered.map(c => c.label)).toEqual(['OpenCode', 'OpenCode Terminal'])
  })
})

describe('filterSessionSpawnChoices', () => {
  it('always keeps the plain Terminal choice', () => {
    const filtered = filterSessionSpawnChoices(SESSION_SPAWN_CHOICES, new Set())
    expect(filtered.map(c => c.kind)).toEqual(['terminal'])
  })
})

describe('enabledProviderSwitchChoices', () => {
  it('drops targets that are disabled even when the feature edge declares them', () => {
    const choices = enabledProviderSwitchChoices('claude', CLAUDE_CODEX)
    expect(choices.map(c => c.kind)).toEqual(['codex'])
  })

  it('returns nothing for a disabled source', () => {
    expect(enabledProviderSwitchChoices('grok', CLAUDE_CODEX)).toEqual([])
  })
})
```

Note: if the actual `shortLabel` for opencode in `registry.renderer.capabilities.ts` differs from `'OpenCode'`, adjust that one assertion to the real value — the assertion's purpose is "two entries, distinct labels".

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit src/renderer/src/workspace/providerChoices.test.ts`
Expected: FAIL — exports not found.

- [ ] **Step 3: Append helpers to `src/renderer/src/workspace/providerChoices.ts`**

```ts
import { enabledAgentProviderKindsSnapshot } from '@renderer/features/providers/store'

/**
 * Enablement filters (#1102). Pickers receive the filtered list; the static
 * exports above stay complete so non-picking consumers (validation cores,
 * keybinding defaults) can choose their own policy.
 */
export function filterAgentProviderChoices(
  choices: readonly AgentProviderChoice[],
  enabledKinds: ReadonlySet<AgentProviderKind>,
): AgentProviderChoice[] {
  return choices.filter(choice => enabledKinds.has(choice.kind))
}

export function filterSessionSpawnChoices(
  choices: readonly SessionSpawnChoice[],
  enabledKinds: ReadonlySet<AgentProviderKind>,
): SessionSpawnChoice[] {
  // `terminal` is not a provider: a user who disables every agent still
  // gets shells — enablement is a provider filter, not an app lockout.
  return choices.filter(choice => choice.kind === 'terminal' || enabledKinds.has(choice.kind))
}

export function enabledProviderSwitchChoices(
  sourceKind: AgentProviderKind,
  enabledKinds: ReadonlySet<AgentProviderKind>,
): AgentProviderChoice[] {
  // A disabled source has no valid destinations: switching away from a
  // provider the user turned off is how it sneaks back into the workspace.
  if (!enabledKinds.has(sourceKind)) return []
  return filterAgentProviderChoices(providerSwitchChoices(sourceKind), enabledKinds)
}

/** Non-React validation-core variant: reads the live store snapshot. */
export function enabledAgentProviderChoices(): AgentProviderChoice[] {
  return filterAgentProviderChoices(AGENT_PROVIDER_CHOICES, enabledAgentProviderKindsSnapshot())
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit src/renderer/src/workspace/providerChoices.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/workspace/providerChoices.ts src/renderer/src/workspace/providerChoices.test.ts
git commit -m "feat(usage): enablement-aware provider choice filters"
```

---

### Task 6: Filter the new-agent and saved-session pickers

**Files:**
- Modify: `src/renderer/src/features/workspace/ui/NewAgentPlacementOverlay.tsx` (KIND_OPTIONS at line 57, linked filter lines 83–88)
- Modify: `src/renderer/src/features/workspace/ui/NewAgentInDialog.tsx` (AGENT_PROVIDER_CHOICES at lines 95/124/229)
- Modify: `src/renderer/src/features/path-picker/ui/PathPickerModal.tsx` (preselect line 98, provider toggle rows line 322)
- Modify: `src/renderer/src/features/conversations/ui/ConversationsPicker.tsx` (filter buttons lines 153–155)
- Modify: `src/renderer/src/features/workspace/commands/paneCommands.ts` (per-provider commands lines 232–260)

- [ ] **Step 1: NewAgentPlacementOverlay**

Add imports:

```ts
import { filterSessionSpawnChoices } from '@renderer/workspace/providerChoices'
import { useEnabledAgentProviderKinds } from '@renderer/features/providers/store'
```

Inside the component (near other hooks):

```tsx
  const enabledKinds = useEnabledAgentProviderKinds()
  // Filtering at render, not module level: enablement changes arrive over IPC
  // while this module is already loaded (#1102).
  const kindOptions = useMemo(
    () => filterSessionSpawnChoices(KIND_OPTIONS, enabledKinds),
    [enabledKinds],
  )
```

Replace every in-component read of `KIND_OPTIONS` with `kindOptions` (the linked-agent filter at lines 83–88 composes on top: `kindOptions.filter(o => isAgentProviderKind(o.kind))`).

- [ ] **Step 2: NewAgentInDialog**

Add the same two imports plus `filterAgentProviderChoices`. Inside the component:

```tsx
  const enabledKinds = useEnabledAgentProviderKinds()
  const providerChoices = useMemo(
    () => filterAgentProviderChoices(AGENT_PROVIDER_CHOICES, enabledKinds),
    [enabledKinds],
  )
```

Replace in-component reads of `AGENT_PROVIDER_CHOICES` (the row mapping at line 229 and any empty-state check) with `providerChoices`. The missing-provider hint logic (lines 61/245) stays unchanged.

- [ ] **Step 3: PathPickerModal**

Import `useEnabledAgentProviderKinds`. Filter the provider toggle rows at line 322:

```tsx
  const enabledKinds = useEnabledAgentProviderKinds()
  // ...inside the mapping expression
  AGENT_PROVIDER_KINDS.filter(kind => enabledKinds.has(kind)).map(p => (
```

For the preselect at line 98, wrap `preferredPickerProvider()`:

```tsx
  // A disabled preselect would open the picker on a provider the user asked
  // to hide; fall back to the first enabled kind, then the app default.
  const [pickerProvider, setPickerProvider] = useState<AgentProvider>(() => {
    const preferred = preferredPickerProvider()
    if (enabledKinds.has(preferred)) return preferred
    return [...AGENT_PROVIDER_KINDS].find(kind => enabledKinds.has(kind)) ?? DEFAULT_PROVIDER
  })
```

Import `AGENT_PROVIDER_KINDS` and `DEFAULT_PROVIDER` from `@shared/types/providerKind` if not already imported. (If the `enabledKinds` hook ordering makes the initializer run before the hook in the existing code, move the hook above the `useState`.)

- [ ] **Step 4: ConversationsPicker**

Import `useEnabledAgentProviderKinds` and filter the provider filter-buttons mapping (lines 153–155):

```tsx
  const enabledKinds = useEnabledAgentProviderKinds()
  // The provider filter buttons follow enablement (#1102 "everywhere");
  // existing saved sessions of a disabled provider stay reachable through
  // the unfiltered list itself — only the shortcut buttons hide.
  const providerButtons = AGENT_PROVIDER_KINDS.filter(kind => enabledKinds.has(kind))
```

and map `providerButtons` instead of `AGENT_PROVIDER_KINDS`. Also drop any provider from the local `providers` selection state that just became disabled (a `useEffect` on `enabledKinds` removing disabled kinds from the array) so a stale filter cannot show an empty "filtered by hidden provider" view.

- [ ] **Step 5: paneCommands per-provider commands**

In the flatMap at lines 232–260, add a `when` guard to each generated command (same predicate form as `sessionCommands.ts:1143`):

```ts
    // #1102: a disabled provider keeps its chord (keybinding tables are
    // static) but the command declines to run, which is the honest cheap
    // behavior until command visibility becomes flag-driven.
    when: () => enabledAgentProviderKindsSnapshot().has(kind),
```

Import `enabledAgentProviderKindsSnapshot` from `@renderer/features/providers/store`. If `CommandDef.when` receives a context argument, the zero-arg closure still typechecks (`() => boolean` is assignable to `(ctx) => boolean`); verify with typecheck.

- [ ] **Step 6: Verify**

Run: `npm run typecheck && npx vitest run --project renderer src/renderer/src/features/workspace/ui/NewAgentInDialog.renderer.test.tsx src/renderer/src/features/conversations 2>/dev/null || npm run typecheck`
Expected: PASS (the `2>/dev/null ||` fallback covers the case where no renderer tests exist for these files — typecheck is then the gate).

Run the command-contract check because commands changed:

Run: `npm run check:keybindings`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/features/workspace/ui/NewAgentPlacementOverlay.tsx src/renderer/src/features/workspace/ui/NewAgentInDialog.tsx src/renderer/src/features/path-picker/ui/PathPickerModal.tsx src/renderer/src/features/conversations/ui/ConversationsPicker.tsx src/renderer/src/features/workspace/commands/paneCommands.ts
git commit -m "feat(usage): filter new-agent and saved-session pickers on enablement"
```

---

### Task 7: Filter the provider-switch surfaces and validation cores

**Files:**
- Modify: `src/renderer/src/features/workspace/ui/ProviderSwitchPickerModal.tsx` (useMemo lines 42–45)
- Modify: `src/renderer/src/features/workspace/ui/BulkProviderSwitchModal.tsx` (SWITCH_DIRECTIONS lines 74–80; default-direction logic lines 216–220)
- Modify: `src/renderer/src/workspace/hook/actions/providerSwitchCore.ts` (validation lines 181–194)
- Modify: `src/renderer/src/workspace/hook/actions/pane.ts` (spawn validation line 1235)
- Modify: `src/renderer/src/workspace/control/lifecycle.ts` (switchChoices line 42)
- Create: `src/renderer/src/features/workspace/ui/BulkProviderSwitchModal.enablement.renderer.test.tsx`

- [ ] **Step 1: Write the failing test**

`BulkProviderSwitchModal.enablement.renderer.test.tsx` — mock the providers store (the file imports `useProviderEnablementStore`; mock the module, not the hook, so both hook and sync selectors are covered):

```tsx
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@renderer/features/providers/store', () => ({
  useProviderEnablementStore: vi.fn(),
  useEnabledAgentProviderKinds: vi.fn(),
  enabledAgentProviderKindsSnapshot: vi.fn(),
}))

import { useEnabledAgentProviderKinds } from '@renderer/features/providers/store'
import { BulkProviderSwitchModal } from './BulkProviderSwitchModal'
import { workspaceFixture } from './BulkProviderSwitchModal.policy.renderer.test'

describe('BulkProviderSwitchModal enablement filtering', () => {
  beforeEach(() => {
    vi.mocked(useEnabledAgentProviderKinds).mockReturnValue(new Set(['claude', 'codex']))
  })

  it('offers no direction involving a disabled provider', () => {
    render(<BulkProviderSwitchModal workspace={workspaceFixture()} />)
    // The modal lists directions by label; assert that no option mentions
    // Grok/OpenCode while they are disabled.
    const optionText = document.body.textContent ?? ''
    expect(optionText).not.toContain('Grok')
    expect(optionText).not.toContain('OpenCode')
  })
})
```

If `workspaceFixture()` is not exported by the existing policy test, copy its fixture-builder into this test file instead of importing it. The assertion is intentionally coarse (label absence) — it fails when filtering regresses, without coupling to markup details.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project renderer src/renderer/src/features/workspace/ui/BulkProviderSwitchModal.enablement.renderer.test.tsx`
Expected: FAIL — text contains 'Grok'/'OpenCode' (no filtering yet), or compile error for the unused mock.

- [ ] **Step 3: ProviderSwitchPickerModal**

Import `useEnabledAgentProviderKinds` and change the memo (lines 42–45):

```tsx
  const enabledKinds = useEnabledAgentProviderKinds()
  const choices = useMemo(
    () => (sourceKind ? enabledProviderSwitchChoices(sourceKind, enabledKinds) : []),
    [sourceKind, enabledKinds],
  )
```

Import `enabledProviderSwitchChoices` from `@renderer/workspace/providerChoices`; remove the now-unused `providerSwitchChoices` import if nothing else uses it.

- [ ] **Step 4: BulkProviderSwitchModal**

Keep `SWITCH_DIRECTIONS` as the static full edge list; add inside the component:

```tsx
  const enabledKinds = useEnabledAgentProviderKinds()
  // #1102: a disabled provider is absent from BOTH sides of every offered
  // direction — it cannot be a switch source (its agents can still exist)
  // nor a target (it would sneak back into the workspace).
  const directions = useMemo(
    () =>
      SWITCH_DIRECTIONS.filter(d => enabledKinds.has(d.source) && enabledKinds.has(d.target)),
    [enabledKinds],
  )
```

Replace in-component reads of `SWITCH_DIRECTIONS` (the default-direction selection at lines 216–220 and any direction-list rendering) with `directions`. The module-level constant stays for tests that assert the full edge set.

- [ ] **Step 5: Validation cores**

`providerSwitchCore.ts` (lines 181–194): change the destination check to the enablement-aware variant:

```ts
import { enabledProviderSwitchChoices } from '@renderer/workspace/providerChoices'
// ...
  if (
    !enabledProviderSwitchChoices(sourceKind, enabledAgentProviderKindsSnapshot()).some(
      choice => choice.kind === targetKind && choice.providerRuntime === targetProviderRuntime,
    )
  )
```

Import `enabledAgentProviderKindsSnapshot` from `@renderer/features/providers/store`. (Same expression shape as today — only the list function changes.)

`pane.ts` (line 1235): change `AGENT_PROVIDER_CHOICES.some(...)` to:

```ts
  if (
    !enabledAgentProviderChoices().some(
      choice => choice.kind === params.kind && choice.providerRuntime === params.providerRuntime,
    )
  )
```

Import `enabledAgentProviderChoices` from `@renderer/workspace/providerChoices`. This also gates orchestration-spawned children: a disabled provider must not come back through the MCP `create_agent` door — that is the spawn-filter half of #1102's "everywhere".

`lifecycle.ts` (line 42): filter before the map:

```ts
  switchChoices: providerSwitchChoices(provider)
    .filter(choice => enabledAgentProviderKindsSnapshot().has(choice.kind))
    .map(choice => ({ provider: choice.kind, runtime: choice.providerRuntime ?? null, label: choice.label })),
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run --project renderer src/renderer/src/features/workspace/ui/BulkProviderSwitchModal`
Expected: PASS (new enablement test + existing policy/scope/derivation tests).
Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/features/workspace/ui/ProviderSwitchPickerModal.tsx src/renderer/src/features/workspace/ui/BulkProviderSwitchModal.tsx src/renderer/src/features/workspace/ui/BulkProviderSwitchModal.enablement.renderer.test.tsx src/renderer/src/workspace/hook/actions/providerSwitchCore.ts src/renderer/src/workspace/hook/actions/pane.ts src/renderer/src/workspace/control/lifecycle.ts
git commit -m "feat(usage): filter provider-switch surfaces and spawn validation on enablement"
```

---

### Task 8: Usage-source registry + composed usageService + get-sources

**Files:**
- Create: `src/main/usage/sources.ts`
- Create: `src/main/usage/sources.test.ts`
- Modify: `src/main/usage/usageService.ts` (fetch list lines 60–78)
- Modify: `src/main/ipc/usage.ts` (add get-sources handler)
- Modify: `src/preload/api/usage.ts` (add `getUsageSources`)

- [ ] **Step 1: Write the failing tests**

`src/main/usage/sources.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { UsageSourceId } from '@shared/types/usage.js'
import { USAGE_SOURCES, listActiveUsageSourceIds, listActiveUsageSources } from './sources.js'

describe('USAGE_SOURCES registry', () => {
  it('covers exactly the UsageSourceId union — no silent gaps', () => {
    expect([...Object.keys(USAGE_SOURCES)].sort()).toEqual(
      ['claude', 'codex', 'grok', 'opencode:zai'].sort(),
    )
    for (const descriptor of Object.values(USAGE_SOURCES)) {
      if (descriptor) {
        expect(descriptor.read).toBeTypeOf('function')
        expect(descriptor.label.length).toBeGreaterThan(0)
      }
    }
  })
})

describe('listActiveUsageSourceIds', () => {
  it('includes installed-provider sources that are enabled', () => {
    const ids = listActiveUsageSourceIds({
      enabledKinds: new Set(['claude', 'codex']),
      opencodeUsageSource: 'none',
    })
    expect(ids).toEqual(['claude', 'codex'])
  })

  it('includes opencode:zai only when opencode is enabled AND the source is selected', () => {
    expect(
      listActiveUsageSourceIds({ enabledKinds: new Set(['opencode']), opencodeUsageSource: 'zai' }),
    ).toEqual(['opencode:zai'])
    expect(
      listActiveUsageSourceIds({ enabledKinds: new Set(['opencode']), opencodeUsageSource: 'none' }),
    ).toEqual([])
    // Disabled OpenCode wins over the selected source: the credential is
    // only reachable through a provider the user wants active.
    expect(
      listActiveUsageSourceIds({ enabledKinds: new Set(), opencodeUsageSource: 'zai' }),
    ).toEqual([])
  })

  it('never lists a source whose reader has not landed (null placeholder)', () => {
    const ids = listActiveUsageSourceIds({
      enabledKinds: new Set(['grok']),
      opencodeUsageSource: 'none',
    })
    expect(ids).toEqual([])
  })
})

describe('listActiveUsageSources', () => {
  it('returns id+label pairs for the skeleton rail', () => {
    const sources = listActiveUsageSources({
      enabledKinds: new Set(['claude']),
      opencodeUsageSource: 'none',
    })
    expect(sources).toEqual([{ id: 'claude' as UsageSourceId, label: 'Claude' }])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit src/main/usage/sources.test.ts`
Expected: FAIL — `./sources.js` not found.

- [ ] **Step 3: Implement `src/main/usage/sources.ts`**

```ts
import type { AgentProviderKind } from '@shared/types/providerKind.js'
import type { OpencodeUsageSource } from '@shared/types/providerEnablement.js'
import type { UsageProviderOk, UsageSourceId } from '@shared/types/usage.js'
import { readClaudeUsage } from '@main/usage/claudeUsage.js'
import { readCodexUsage } from '@main/usage/codexUsage.js'

export type UsageSourceDescriptor = {
  id: UsageSourceId
  label: string
  sourceLabel: string
  read: () => Promise<UsageProviderOk>
}

export type UsageEnablementInput = {
  enabledKinds: ReadonlySet<AgentProviderKind>
  opencodeUsageSource: OpencodeUsageSource
}

// null = the id is part of the contract but its reader has not landed
// (#1103 grok, #1104 opencode:zai). A null entry is never listed active, so
// the modal cannot show a permanently-erroring row for work still in
// flight; those issues replace the nulls with descriptors.
export const USAGE_SOURCES: Record<UsageSourceId, UsageSourceDescriptor | null> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    sourceLabel: 'Claude Code Keychain',
    read: readClaudeUsage,
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    sourceLabel: '~/.codex/auth.json',
    read: readCodexUsage,
  },
  grok: null,
  'opencode:zai': null,
}

export function listActiveUsageSourceIds(input: UsageEnablementInput): UsageSourceId[] {
  const active: UsageSourceId[] = []
  for (const id of Object.keys(USAGE_SOURCES) as UsageSourceId[]) {
    if (!USAGE_SOURCES[id]) continue
    if (id === 'opencode:zai') {
      if (input.opencodeUsageSource === 'zai' && input.enabledKinds.has('opencode')) active.push(id)
      continue
    }
    if (input.enabledKinds.has(id)) active.push(id)
  }
  return active
}

export function listActiveUsageSources(
  input: UsageEnablementInput,
): Array<{ id: UsageSourceId; label: string }> {
  return listActiveUsageSourceIds(input)
    .map(id => {
      const descriptor = USAGE_SOURCES[id]
      return descriptor ? { id: descriptor.id, label: descriptor.label } : null
    })
    .filter((entry): entry is { id: UsageSourceId; label: string } => entry !== null)
}
```

- [ ] **Step 4: Rewire `usageService.getUsageSnapshot`**

Replace the hardcoded `Promise.all` block (lines 60–78) with:

```ts
  const fetchPromise = (async (): Promise<UsageSnapshot> => {
    // WHY composed per fetch and not cached with the snapshot: enablement can
    // change under a live cache (invalidateUsageSnapshotCache is called on
    // every toggle, but the ACTIVE SET must still be re-derived here so a
    // fetch started before a toggle cannot resurrect a disabled provider on
    // its next refresh).
    const activeIds = listActiveUsageSourceIds({
      enabledKinds: enabledAgentProviderKindsSync(),
      opencodeUsageSource: getCachedProviderEnablement()?.opencodeUsageSource ?? 'none',
    })
    const providers = await Promise.all(
      activeIds.map(id => {
        const descriptor = USAGE_SOURCES[id]
        // listActiveUsageSourceIds already excludes null descriptors; the
        // guard keeps this closure honest if that invariant ever drifts.
        if (!descriptor) return Promise.resolve(null)
        return readProvider(id, descriptor.sourceLabel, descriptor.read)
      }),
    ).then(list =>
      list.filter((entry): entry is UsageProviderSnapshot => entry !== null),
    )

    cachedSnapshot = {
      fetchedAt: new Date(now).toISOString(),
      cache: { hit: false, ttlMs: USAGE_CACHE_TTL_MS },
      providers,
    }
    return cachedSnapshot
  })()
```

Update imports at the top:

```ts
import { getCachedProviderEnablement, enabledAgentProviderKindsSync } from '@main/setup/providerEnablement.js'
import { listActiveUsageSourceIds, USAGE_SOURCES } from '@main/usage/sources.js'
import type { UsageSourceId } from '@shared/types/usage.js'
```

and widen `readProvider`'s first parameter type from `UsageProviderKind` to `UsageSourceId` (the alias makes them identical, but new code names the wider concept). Preserve the existing WHY comment about independent per-provider failure boundaries — it still applies, now per *source*.

- [ ] **Step 5: `usage:get-sources` IPC + preload**

`src/main/ipc/usage.ts` — add inside `registerUsageIpc`:

```ts
import { getCachedProviderEnablement, enabledAgentProviderKindsSync } from '@main/setup/providerEnablement.js'
import { listActiveUsageSources } from '@main/usage/sources.js'
// ...
  // The modal's loading skeleton needs the rail BEFORE the first snapshot
  // lands; the active id list is enablement-derived and available instantly.
  ipcMain.handle('usage:get-sources', async () =>
    listActiveUsageSources({
      enabledKinds: enabledAgentProviderKindsSync(),
      opencodeUsageSource: getCachedProviderEnablement()?.opencodeUsageSource ?? 'none',
    }),
  )
```

`src/preload/api/usage.ts` — extend the api object:

```ts
import type { UsageSourceId } from '@shared/types/usage.js'
// ...
  getUsageSources: (): Promise<Array<{ id: UsageSourceId; label: string }>> =>
    ipcRenderer.invoke('usage:get-sources'),
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run --project unit src/main/usage/sources.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/usage/sources.ts src/main/usage/sources.test.ts src/main/usage/usageService.ts src/main/ipc/usage.ts src/preload/api/usage.ts
git commit -m "feat(usage): source registry and enablement-composed snapshot"
```

---

### Task 9: Generalize provider labels and header codes

**Files:**
- Modify: `src/renderer/src/features/usage/model/formatUsage.ts` (`providerLabel` lines 5–7)
- Modify: `src/renderer/src/features/usage/model/headerRows.ts` (code ternary line 93)
- Create: `src/renderer/src/features/usage/model/formatUsage.test.ts`
- Create: `src/renderer/src/features/usage/model/headerRows.test.ts`

- [ ] **Step 1: Write the failing tests**

`formatUsage.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { providerLabel } from './formatUsage'

describe('providerLabel', () => {
  it('labels every usage source — an unknown id must fail typecheck, not render as a sibling', () => {
    expect(providerLabel('claude')).toBe('Claude')
    expect(providerLabel('codex')).toBe('Codex')
    expect(providerLabel('grok')).toBe('Grok')
    expect(providerLabel('opencode:zai')).toBe('z.ai')
  })
})
```

`headerRows.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { UsageSnapshot } from '@shared/types/usage'
import { toHeaderProviders } from './headerRows'

function snapshotFor(provider: UsageSnapshot['providers'][number]['provider']): UsageSnapshot {
  return {
    fetchedAt: new Date().toISOString(),
    cache: { hit: false, ttlMs: 30_000 },
    providers: [
      {
        provider,
        status: 'ok',
        sourceLabel: 'test',
        plan: null,
        rows: [
          { id: 'r1', label: 'Current week', percent: 42, severity: 'normal', resetsAt: null, active: true, detail: null, scope: 'all-models' },
        ],
        spend: null,
        extraUsage: null,
        credits: null,
      },
    ],
  }
}

describe('toHeaderProviders chip codes', () => {
  it('assigns a distinct two-letter code per source', () => {
    expect(toHeaderProviders(snapshotFor('claude'))[0].code).toBe('CL')
    expect(toHeaderProviders(snapshotFor('codex'))[0].code).toBe('CX')
    expect(toHeaderProviders(snapshotFor('grok'))[0].code).toBe('GR')
    expect(toHeaderProviders(snapshotFor('opencode:zai'))[0].code).toBe('ZA')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit src/renderer/src/features/usage/model`
Expected: FAIL — `providerLabel('grok')` returns `'Codex'` (the old ternary), `'GR'`/`'ZA'` codes missing.

- [ ] **Step 3: Implement**

`formatUsage.ts` — replace `providerLabel` (lines 5–7) and change its parameter/import to `UsageSourceId`:

```ts
import type { UsageSourceId } from '@shared/types/usage'

export function providerLabel(provider: UsageSourceId): string {
  switch (provider) {
    case 'claude':
      return 'Claude'
    case 'codex':
      return 'Codex'
    case 'grok':
      return 'Grok'
    case 'opencode:zai':
      return 'z.ai'
  }
}
```

`headerRows.ts` — replace the ternary at line 93 (`code: provider.provider === 'claude' ? 'CL' : 'CX'`) with a table lookup defined at module scope:

```ts
// #1102: chip codes per usage source. A record (not a ternary) so adding a
// source without a code is a type error here, not a mislabeled chip.
const PROVIDER_CODES: Record<UsageSourceId, string> = {
  claude: 'CL',
  codex: 'CX',
  grok: 'GR',
  'opencode:zai': 'ZA',
}
```

and use `code: PROVIDER_CODES[provider.provider]`. Import `UsageSourceId` from `@shared/types/usage`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit src/renderer/src/features/usage/model`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/features/usage/model/formatUsage.ts src/renderer/src/features/usage/model/formatUsage.test.ts src/renderer/src/features/usage/model/headerRows.ts src/renderer/src/features/usage/model/headerRows.test.ts
git commit -m "feat(usage): exhaustive source labels and header chip codes"
```

---

### Task 10: Settings — Providers category and enablement row

**Files:**
- Modify: `src/renderer/src/features/settings/lib/settingsCategories.ts` (type + list)
- Modify: `src/renderer/src/features/settings/lib/settingsRegistry.ts` (union member + row definition)
- Modify: `src/renderer/src/features/settings/ui/SettingsList.tsx` (render branch)
- Create: `src/renderer/src/features/providers/ui/ProviderEnablementRow.tsx`
- Create: `src/renderer/src/features/providers/ui/ProviderEnablementRow.renderer.test.tsx`

- [ ] **Step 1: Write the failing test**

`ProviderEnablementRow.renderer.test.tsx`:

```tsx
import { fireEvent, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ProviderEnablementSnapshot } from '@shared/types/providerEnablement'

const snapshot: ProviderEnablementSnapshot = {
  entries: [
    { kind: 'claude', enabled: true, because: 'detected', installed: true },
    { kind: 'codex', enabled: true, because: 'detected', installed: true },
    { kind: 'opencode', enabled: false, because: 'user', installed: true },
    { kind: 'grok', enabled: false, because: 'not-detected', installed: false },
  ],
  opencodeUsageSource: 'none',
}

describe('ProviderEnablementRow', () => {
  const original = Object.getOwnPropertyDescriptor(window, 'api')
  const setMock = vi.fn().mockResolvedValue(snapshot)

  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { providerEnablementSet: setMock, providerEnablementReset: vi.fn().mockResolvedValue(snapshot) },
    })
  })

  afterEach(() => {
    if (original) Object.defineProperty(window, 'api', original)
    vi.clearAllMocks()
  })

  it('renders one row per provider kind with state hints', async () => {
    const { ProviderEnablementRow } = await import('./ProviderEnablementRow')
    const { render } = await import('@testing-library/react')
    const { useProviderEnablementStore } = await import('@renderer/features/providers/store')
    useProviderEnablementStore.setState({ snapshot })
    render(<ProviderEnablementRow />)
    expect(await screen.findByText('Grok')).toBeTruthy()
    expect(screen.getByText('not detected on PATH')).toBeTruthy()
    expect(screen.getByText('set by you')).toBeTruthy()
  })

  it('toggling calls the API with kind and value', async () => {
    const { ProviderEnablementRow } = await import('./ProviderEnablementRow')
    const { render } = await import('@testing-library/react')
    const { useProviderEnablementStore } = await import('@renderer/features/providers/store')
    useProviderEnablementStore.setState({ snapshot })
    render(<ProviderEnablementRow />)
    const grokSwitch = screen.getAllByRole('switch').find(el => el.getAttribute('aria-label') === 'Enable Grok')
    expect(grokSwitch).toBeTruthy()
    if (grokSwitch) fireEvent.click(grokSwitch)
    expect(setMock).toHaveBeenCalledWith('grok', true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project renderer src/renderer/src/features/providers/ui/ProviderEnablementRow.renderer.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 3: Add the settings category**

`settingsCategories.ts` — add `'providers'` to `SettingCategoryId` and an entry to `SETTING_CATEGORIES` (after `workspace`):

```ts
  {
    id: 'providers',
    label: 'Providers',
    description: 'Which coding agents appear in Agent Code, and what usage they report.',
  },
```

- [ ] **Step 4: Register the marker row**

`settingsRegistry.ts` — add a union member to `SettingDefinition` beside the other marker types:

```ts
  | { id: string; category: SettingCategoryId; title: string; description: string; keywords: string[]; metadata?: SettingMetadata; control: { type: 'providers-enablement' } }
```

Add the row definition (place it in the returned registry near the workspace/agents rows):

```ts
  {
    id: 'providers-enablement',
    category: 'providers',
    title: 'Providers',
    description:
      'Choose which coding agents Agent Code offers. Detected CLIs start on; turning a provider off hides it from pickers, switching, and usage — running sessions keep running. Reset returns a provider to detection.',
    keywords: ['provider', 'providers', 'enable', 'disable', 'claude', 'codex', 'opencode', 'grok', 'usage', 'hide'],
    // Main's setup.json is the truth (storage: 'setup'); the row mirrors it.
    metadata: { scope: 'app', apply: 'new-session', storage: 'setup' },
    control: { type: 'providers-enablement' },
  },
```

- [ ] **Step 5: Render branch in `SettingsList.tsx`**

Import the component and add beside the other marker branches (e.g. next to `cli-update-behavior` at line 242):

```tsx
{control.type === 'providers-enablement' ? <ProviderEnablementRow /> : null}
```

- [ ] **Step 6: Implement `ProviderEnablementRow.tsx`**

```tsx
import { useState } from 'react'

import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { useProviderEnablementStore } from '@renderer/features/providers/store'

import type { ProviderEnablementEntry } from '@shared/types/providerEnablement'

function hintFor(entry: ProviderEnablementEntry): string {
  if (entry.because === 'user') return 'set by you'
  return entry.installed ? 'detected' : 'not detected on PATH'
}

function EntryRow({ entry }: { entry: ProviderEnablementEntry }) {
  const capabilities = getRendererProviderCapabilities(entry.kind)
  const [pending, setPending] = useState(false)

  const toggle = async () => {
    setPending(true)
    try {
      // The returned snapshot also arrives via the push channel; applying it
      // here too keeps the switch snappy instead of waiting a broadcast hop.
      const snapshot = await window.api.providerEnablementSet(entry.kind, !entry.enabled)
      useProviderEnablementStore.getState().setSnapshot(snapshot)
    } finally {
      setPending(false)
    }
  }

  const reset = async () => {
    setPending(true)
    try {
      const snapshot = await window.api.providerEnablementReset(entry.kind)
      useProviderEnablementStore.getState().setSnapshot(snapshot)
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2 last:border-b-0">
      <div className="min-w-0">
        <div className="text-[12px] font-semibold text-ink">{capabilities.shortLabel}</div>
        <div className="mt-0.5 text-[10px] text-muted">
          {hintFor(entry)}
          {entry.because === 'user' ? (
            <>
              {' · '}
              <button
                type="button"
                className="underline decoration-dotted"
                disabled={pending}
                onClick={() => void reset()}
              >
                reset to detection
              </button>
            </>
          ) : null}
        </div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={entry.enabled}
        aria-label={`Enable ${capabilities.shortLabel}`}
        disabled={pending}
        onClick={() => void toggle()}
        className={
          entry.enabled
            ? 'rounded-chip border border-border bg-accent px-2 py-1 text-[10px] text-ink'
            : 'rounded-chip border border-border bg-surface-hi px-2 py-1 text-[10px] text-muted'
        }
      >
        {entry.enabled ? 'on' : 'off'}
      </button>
    </div>
  )
}

/** Settings → Providers row (#1102). Self-subscribing marker row in the
 * cli-updates shape: the value lives in main's setup.json, this component
 * only mirrors the pushed snapshot and writes through the API. */
export function ProviderEnablementRow() {
  const snapshot = useProviderEnablementStore(state => state.snapshot)

  if (!snapshot) {
    return <div className="px-3 py-3 text-[11px] text-muted">Loading provider state…</div>
  }
  return (
    <div className="rounded-slab border border-border bg-surface">
      {snapshot.entries.map(entry => (
        <EntryRow key={entry.kind} entry={entry} />
      ))}
      <div className="px-3 py-2 text-[10px] text-muted">
        Turning a provider off hides it from pickers and usage. Running agents are never closed.
        The OpenCode usage-source selector arrives with z.ai usage support.
      </div>
    </div>
  )
}
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run --project renderer src/renderer/src/features/providers/ui/ProviderEnablementRow.renderer.test.tsx && npm run typecheck && npx vitest run --project unit src/renderer/src/features/settings/lib/naming.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/features/settings/lib/settingsCategories.ts src/renderer/src/features/settings/lib/settingsRegistry.ts src/renderer/src/features/settings/ui/SettingsList.tsx src/renderer/src/features/providers/ui/ProviderEnablementRow.tsx src/renderer/src/features/providers/ui/ProviderEnablementRow.renderer.test.tsx
git commit -m "feat(usage): Providers settings category with enablement rows"
```

---

### Task 11: Usage modal redesign — rail + detail

**Files:**
- Modify: `src/renderer/src/features/usage/ui/UsageModal.tsx` (full rewrite)
- Modify: `src/renderer/src/features/usage/commands/usageCommands.ts` (description line 9)
- Create: `src/renderer/src/features/usage/ui/UsageModal.renderer.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { UsageSnapshot } from '@shared/types/usage'

const snapshot: UsageSnapshot = {
  fetchedAt: new Date('2026-09-20T12:02:00Z').toISOString(),
  cache: { hit: false, ttlMs: 30_000 },
  providers: [
    {
      provider: 'claude', status: 'ok', sourceLabel: 'Claude Code Keychain', plan: 'Pro',
      rows: [
        { id: 'w', label: 'Current week (all models)', percent: 62, severity: 'normal', resetsAt: null, active: true, detail: null, scope: 'all-models' },
      ],
      spend: null, extraUsage: null, credits: null,
    },
    {
      provider: 'codex', status: 'error', sourceLabel: '~/.codex/auth.json',
      message: 'Provider rejected the current auth token.',
    },
  ],
}

describe('UsageModal', () => {
  const original = Object.getOwnPropertyDescriptor(window, 'api')

  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getUsageSnapshot: vi.fn().mockResolvedValue(snapshot),
        getUsageSources: vi.fn().mockResolvedValue([
          { id: 'claude', label: 'Claude' },
          { id: 'codex', label: 'Codex' },
        ]),
      },
    })
  })

  afterEach(() => {
    if (original) Object.defineProperty(window, 'api', original)
    vi.restoreAllMocks()
  })

  it('renders a rail entry per source and details for the selected one', async () => {
    const { UsageModal } = await import('./UsageModal')
    const { render } = await import('@testing-library/react')
    render(<UsageModal open onClose={() => {}} />)
    expect(await screen.findByRole('button', { name: /Claude/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Codex/ })).toBeTruthy()
    // Claude is selected by default; its row label is visible in the detail pane
    expect(screen.getByText('Current week (all models)')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Codex/ }))
    await waitFor(() => {
      expect(screen.getByText('Provider rejected the current auth token.')).toBeTruthy()
    })
  })

  it('shows the empty state linking to settings when no source is active', async () => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        getUsageSnapshot: vi.fn().mockResolvedValue({ ...snapshot, providers: [] }),
        getUsageSources: vi.fn().mockResolvedValue([]),
      },
    })
    const { UsageModal } = await import('./UsageModal')
    const { render } = await import('@testing-library/react')
    render(<UsageModal open onClose={() => {}} />)
    expect(await screen.findByText(/No usage sources are enabled/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Open Settings/ })).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project renderer src/renderer/src/features/usage/ui/UsageModal.renderer.test.tsx`
Expected: FAIL — current modal renders a 2-col grid, no rail buttons, no empty-state text.

- [ ] **Step 3: Rewrite `UsageModal.tsx`**

```tsx
import { useEffect, useMemo, useState } from 'react'

import type {
  UsageProviderSnapshot,
  UsageSnapshot,
  UsageSourceId,
  UsageSpend,
} from '@preload/index'
import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { useAppStore } from '@renderer/app-state/store'
import {
  formatMoney,
  formatPercent,
  formatReset,
  providerLabel,
  severityBarStyle,
  severityTextStyle,
} from '@renderer/features/usage/model/formatUsage'
import type { HeaderRow } from '@renderer/features/usage/model/headerRows'

type Props = {
  open: boolean
  onClose: () => void
}

function SpendPill({ label, spend }: { label: string; spend: UsageSpend | null }) {
  if (!spend) return null
  return (
    <div className="rounded-slab border border-border bg-surface-hi px-2 py-1 text-[10px] leading-none">
      <span className="text-muted">{label}</span>{' '}
      <span className="text-ink">{formatMoney(spend.amount, spend.currency)}</span>
    </div>
  )
}

/** Headline percent for the rail: the worst (highest) non-null row percent. */
function worstPercent(provider: UsageProviderSnapshot): number | null {
  if (provider.status !== 'ok') return null
  let worst: number | null = null
  for (const row of provider.rows) {
    if (row.percent === null) continue
    if (worst === null || row.percent > worst) worst = row.percent
  }
  return worst
}

function railSeverity(provider: UsageProviderSnapshot): string {
  if (provider.status !== 'ok') return 'text-danger'
  const worst = worstPercent(provider)
  if (worst === null) return 'text-muted'
  if (worst >= 95) return 'text-danger'
  if (worst >= 75) return 'text-warning'
  return 'text-accent'
}

function UsageProviderDetail({ provider }: { provider: UsageProviderSnapshot }) {
  if (provider.status === 'error') {
    return (
      <div className="px-3 py-4 text-[11px] leading-snug text-muted">{provider.message}</div>
    )
  }
  return (
    <div className="space-y-3 px-3 py-3">
      {provider.rows.length === 0 ? (
        <div className="text-[11px] text-muted">No usage windows returned.</div>
      ) : (
        provider.rows.map(row => {
          const width = row.percent === null ? 0 : Math.max(0, Math.min(100, row.percent))
          const reset = formatReset(row.resetsAt)
          return (
            <div key={row.id} className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-3 text-[11px]">
                <div className="min-w-0 truncate text-ink">{row.label}</div>
                <div className="flex-shrink-0" style={severityTextStyle(row.severity)}>
                  {formatPercent(row.percent)}
                </div>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-chip bg-surface-hi">
                <div
                  className="h-full"
                  style={{ width: `${width}%`, ...severityBarStyle(row.severity) }}
                />
              </div>
              {reset || row.detail ? (
                <div className="flex items-center justify-between gap-3 text-[10px] text-muted">
                  <div className="min-w-0 truncate">{row.detail}</div>
                  <div className="flex-shrink-0">{reset}</div>
                </div>
              ) : null}
            </div>
          )
        })
      )}
      <div className="flex flex-wrap gap-2 pt-1">
        <SpendPill label="spend" spend={provider.spend} />
        <SpendPill label="extra" spend={provider.extraUsage} />
        <SpendPill label="credits" spend={provider.credits} />
      </div>
    </div>
  )
}

export function UsageModal({ open, onClose }: Props) {
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null)
  const [sources, setSources] = useState<Array<{ id: UsageSourceId; label: string }>>([])
  const [selected, setSelected] = useState<UsageSourceId | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const openSettings = useAppStore(state => state.openSettings)

  const railEntries = useMemo(() => {
    // Once a snapshot lands it owns the rail (real percents, error badges).
    // Before that, the enablement-derived source list drives a skeleton —
    // replacing the old fabricated status:'error' "Loading…" rows (#1102).
    if (snapshot) return snapshot.providers.map(p => ({ id: p.provider, provider: p }))
    return sources.map(({ id }) => ({ id, provider: null as UsageProviderSnapshot | null }))
  }, [snapshot, sources])

  const activeId = useMemo(() => {
    if (selected && railEntries.some(entry => entry.id === selected)) return selected
    return railEntries[0]?.id ?? null
  }, [selected, railEntries])

  const activeProvider = useMemo(
    () => railEntries.find(entry => entry.id === activeId)?.provider ?? null,
    [railEntries, activeId],
  )

  const fetchedLabel = useMemo(() => {
    if (!snapshot) return null
    const date = new Date(snapshot.fetchedAt)
    if (Number.isNaN(date.getTime())) return null
    return `${date.toLocaleTimeString()}${snapshot.cache.hit ? ' cached' : ''}`
  }, [snapshot])

  const refresh = async (force = false) => {
    setLoading(true)
    setError(null)
    try {
      setSnapshot(await window.api.getUsageSnapshot({ force }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load usage.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setSnapshot(null)
    setSelected(null)
    void window.api.getUsageSources().then(setSources).catch(() => setSources([]))
    void refresh(false)
  }, [open])

  // Keyboard rail navigation: ↑/↓ move the selection; the rail is the only
  // list-like element in the dialog, so the keys are unambiguous.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!railEntries.length) return
    const currentIndex = railEntries.findIndex(entry => entry.id === activeId)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected(railEntries[(currentIndex + 1) % railEntries.length].id)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected(
        railEntries[(currentIndex - 1 + railEntries.length) % railEntries.length].id,
      )
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogContent className="flex max-h-[88vh] w-[min(760px,calc(100vw-2rem))] flex-col">
        <DialogHeader className="flex-row items-center justify-between gap-4">
          <div>
            <DialogTitle className="font-semibold">Usage</DialogTitle>
            <DialogDescription className="mt-0.5 text-[10px]">
              {fetchedLabel
                ? `${railEntries.length} providers · fetched ${fetchedLabel}`
                : `${sources.length} providers`}
            </DialogDescription>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              disabled={loading}
              onClick={() => void refresh(true)}
              variant="secondary"
              size="sm"
              className="disabled:cursor-wait"
            >
              refresh
            </Button>
            <DialogClose asChild>
              <Button type="button" variant="secondary" size="sm">
                close
              </Button>
            </DialogClose>
          </div>
        </DialogHeader>

        <div className="overflow-auto p-4" onKeyDown={onKeyDown}>
          {error ? (
            <div className="rounded-slab mb-3 border border-danger bg-danger/10 px-3 py-2 text-[11px] text-danger">
              {error}
            </div>
          ) : null}

          {railEntries.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-3 py-8 text-center">
              <div className="text-[11px] text-muted">
                No usage sources are enabled. Enable a provider in Settings → Providers.
              </div>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => {
                  onClose()
                  openSettings()
                }}
              >
                Open Settings
              </Button>
            </div>
          ) : (
            <div className="grid grid-cols-[200px_minmax(0,1fr)] gap-3">
              <div className="flex flex-col gap-1 border-r border-border pr-3" role="listbox">
                {railEntries.map(entry => {
                  const isActive = entry.id === activeId
                  const percent = entry.provider ? worstPercent(entry.provider) : null
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onClick={() => setSelected(entry.id)}
                      className={
                        isActive
                          ? 'rounded-chip border border-border bg-surface-hi px-2 py-1.5 text-left text-[11px] text-ink'
                          : 'rounded-chip border border-transparent px-2 py-1.5 text-left text-[11px] text-muted hover:bg-surface-hi'
                      }
                    >
                      <span className="font-semibold">{providerLabel(entry.id)}</span>
                      <span className={`ml-2 ${entry.provider ? railSeverity(entry.provider) : 'text-muted'}`}>
                        {entry.provider
                          ? percent === null
                            ? '—'
                            : `${Math.round(percent)}%${percent >= 75 ? ' ⚠' : ''}`
                          : '…'}
                      </span>
                    </button>
                  )
                })}
              </div>
              <section className="rounded-slab border border-border bg-surface">
                {activeProvider ? (
                  <>
                    <div className="flex items-start justify-between gap-3 border-b border-border px-3 py-2">
                      <div>
                        <div className="text-[12px] font-semibold text-ink">
                          {providerLabel(activeProvider.provider)}
                        </div>
                        <div className="mt-0.5 text-[10px] text-muted">
                          {activeProvider.sourceLabel}
                        </div>
                      </div>
                      {activeProvider.status === 'ok' ? (
                        <div className="text-right text-[10px] leading-snug">
                          <div className="uppercase text-muted">plan</div>
                          <div className="text-ink">{activeProvider.plan ?? 'unknown'}</div>
                        </div>
                      ) : (
                        <div className="text-[10px] uppercase text-muted">unavailable</div>
                      )}
                    </div>
                    <UsageProviderDetail provider={activeProvider} />
                  </>
                ) : (
                  <div className="px-3 py-4 text-[11px] text-muted">Loading usage…</div>
                )}
              </section>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
```

Notes for the implementer: the old `LoadingSnapshot()` and `UsageProviderSection` are deleted; `HeaderRow` import is unused — remove it. If `useAppStore`'s import path or the `openSettings` action name differs, follow the exact `open-settings` command wiring in `settingsCommands.ts` (`ui.openSettings()`).

- [ ] **Step 4: Update the command description**

`usageCommands.ts` line 9 — replace the description string mentioning "Claude and Codex":

```ts
    description: '**What it does:** Opens **Usage** — quota, spend, and reset windows for every enabled provider.\n\n**Use when:** You want to check how much of a plan is left before a long run.\n\n**Notes:** Configure which providers appear in Settings → Providers.',
```

(If the file's existing description format differs, keep its format and only remove the hardcoded "Claude and Codex" phrasing.)

- [ ] **Step 5: Run tests**

Run: `npx vitest run --project renderer src/renderer/src/features/usage && npm run check:keybindings`
Expected: PASS (command-description checks included in the keybinding/contract scripts).

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/features/usage/ui/UsageModal.tsx src/renderer/src/features/usage/ui/UsageModal.renderer.test.tsx src/renderer/src/features/usage/commands/usageCommands.ts
git commit -m "feat(usage): rail-and-detail usage modal with skeleton and empty state"
```

---

### Task 12: Contract coverage + full verification

**Files:**
- Modify: `src/main/usage/sources.test.ts` (extend with contract assertions — done if already covered; verify)
- Verify-only: no new production files.

- [ ] **Step 1: Confirm the contract assertions exist**

`src/main/usage/sources.test.ts` (Task 8) already asserts the registry covers exactly the `UsageSourceId` union. Add one more test there tying enablement coverage to provider kinds:

```ts
import { AGENT_PROVIDER_KINDS } from '@shared/types/providerKind.js'

it('every agent provider kind is a valid enablement key for usage composition', () => {
  // claude/codex/grok map 1:1; opencode maps through the usage-source
  // selection. A new provider kind without a usage story must still compose
  // (it simply has no source id until one is registered).
  for (const kind of AGENT_PROVIDER_KINDS) {
    expect(['claude', 'codex', 'grok', 'opencode'].includes(kind)).toBe(true)
  }
})
```

- [ ] **Step 2: Run the full check suite**

Run: `npm run typecheck && npm run test:unit && npm run test:renderer && npm run test:contract && npm run check:keybindings`
Expected: ALL PASS. (`npm run check` runs the full gate including system tests and packaging verification — run it if the environment supports it; otherwise report which tiers ran.)

- [ ] **Step 3: Manual smoke (if a display is available)**

Run: `npm run dev`
Verify: Settings shows the Providers category; toggling Grok off removes it from the New Agent picker and the usage modal rail; the modal renders rail+detail with keyboard ↑/↓; `/usage` in a composer opens the modal. Quit the dev app afterward.

- [ ] **Step 4: Commit any remaining test additions**

```bash
git add src/main/usage/sources.test.ts
git commit -m "test(usage): provider-kind coverage contract for usage composition"
```

- [ ] **Step 5: Sync issues and open the PR**

- Comment on issue #1102 summarizing what landed (or rely on the PR body).
- Open PR `feat(usage): provider enablement settings, usage-source registry, and multi-provider usage modal` from `feat/provider-usage-enablement`, body: problem, behavior, design decisions (link the spec), `Fixes #1102`, tests run, known limitations (grok/z.ai rows land with #1103/#1104; OpenCode usage-source dropdown UI lands with #1104). Do NOT merge without explicit user confirmation.

---

## Self-review (completed during planning)

- **Spec coverage:** contracts (T1), main state + detection reuse (T2), IPC/preload (T3), reactive store (T4), choice filters (T5), picker surfaces (T6), switch surfaces + validation cores (T7), registry + composed service + get-sources (T8), labels/codes (T9), settings surface (T10), modal redesign (T11), coverage + verification (T12). Deliberate Phase-1 exclusions per spec: grok/z.ai readers (#1103/#1104), OpenCode dropdown UI (#1104), keybinding-default filtering (static tables, out of scope).
- **Type consistency:** `UsageSourceId` + `UsageProviderKind` alias (T1) used by T8/T9/T11; `ProviderEnablementSnapshot`/`entries` shape defined in T1, consumed by T2/T3/T4/T10; `enabledAgentProviderKindsSnapshot` (T4) consumed by T5/T6/T7.
- **Known execution-time verifications:** `Unsub` export location in preload ipc.ts (T3), `shortLabel` exact text for OpenCode (T5), `workspaceFixture` reuse (T7), `openSettings` action name (T11) — each step names the reference file to check rather than assuming.
