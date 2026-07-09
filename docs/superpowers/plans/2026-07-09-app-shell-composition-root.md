# App.tsx Thin Composition Root + Surface Registry — Implementation Plan (issue #494)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce `src/renderer/src/app/App.tsx` from a 1152-line god render-root to a ~120-line composition root: providers → layout shell → registry-driven `<GlobalSurfaces/>` → a handful of named hooks, with **zero behavior change**.

**Architecture:** Every global modal/overlay/panel becomes a self-contained *surface wrapper* file living in its owning feature (reads its own store flags + workspace context, replicates App.tsx's exact mount semantics). One registry (`app/surfaces/registry.tsx`, mirroring the existing command registry pattern) aggregates the wrappers into three render groups placed at the exact DOM positions App used today. The 13 root effects each move verbatim into a feature-owned `useXxx()` hook. A new `WorkspaceContext` eliminates the `workspace` prop drilling that forced everything through App.

**Tech Stack:** React 18, zustand (existing 3-slice `useAppStore`), TypeScript project references (`tsc -b`), Vitest 4 + happy-dom for existing renderer tests.

**Branch/worktree:** `refactor/app-shell-composition-root` in `.worktrees/app-shell-refactor` (already created).

## Global Constraints

- **No behavior change.** Pure extraction. Every effect body, WHY comment, and mount-semantic (always-mounted-with-`open`-prop vs conditional `{flag && <X/>}`) moves **verbatim**. When this plan says "verbatim" it means copy the code and its comments from App.tsx, adjusting only identifier sources (store selectors / context instead of props).
- **No new test files, no new `test:*` scripts** (user policy). Verification per task = `npx tsc -b` + `npm run test:renderer` (existing suite) + the final manual pass in Task 13. Temporary throwaway checks are fine but must not be committed.
- **Typecheck gate:** `npx tsc -b` (root config; covers node + web projects) must pass after **every task**. This is the entire safety net for this class of change — the `workspace.reader` typo that shipped (App.tsx:311-320 comment) is the cautionary tale. Note: `tsc -p tsconfig.web.json --noEmit` is REJECTED (composite project) — always use `tsc -b`.
- **Thick WHY comments** (CLAUDE.md): every moved effect keeps its original comment block; every new file explains why it exists and what invariant it protects.
- **#493 coexistence (another agent is working on it right now):** do NOT touch `workspace/semantic/*`, `workspace/ghosts.ts`, `workspace/mergedEntries.ts`, `workspace/hook/ipc/useIpcSubscriptions.ts`, `rendering/*`, or `features/feed/` internals (App's one feed import, `AppearanceMenu`, only *moves* into `app/shell/SettingsBar.tsx` — a one-line import that rebases trivially if #493 relocates it). All new files in this plan are net-new paths #493 does not create.
- **Remote-client isolation:** the phone bundle re-imports the `@renderer` feed subtree with only four Vite-aliased desktop modules. Nothing in this plan may add `window.api` calls to files inside the shared feed subtree. All new hooks/wrappers live in `app/`, `features/<x>/surfaces|hooks/`, or `workspace/hook/effects/` — none are imported by `src/remote-client`.
- **`SessionFeedProvider` in `main.tsx` stays the sole transport-selection point.** This plan does not touch `main.tsx`.
- **Commit per task**, message style `refactor(app-shell): <what> (#494)`. Do not push/merge — open a PR at the end and stop (user policy: no auto-merge).

## Design Decisions (read before implementing)

1. **Explicit aggregation, not side-effect self-registration.** Issue #494 sketches "each surface self-registers." We instead mirror the proven command-registry pattern (`features/command-palette/registry.ts`): per-feature wrapper files + one grep-able aggregate array in `app/surfaces/registry.tsx`. Adding a surface = 1 new wrapper file + 1 import line in the registry, **zero App.tsx edits** (satisfies the acceptance criterion; `import.meta.glob` magic was rejected — invisible to grep and to the compiler's unused-import checks).
2. **No `when(state)` gate on registry entries.** The issue sketches `{ id, when(state), Component }`, but mount semantics are load-bearing and differ per surface: most modals are ALWAYS mounted with an `open` prop (internal state like a half-typed search query survives close/reopen), while panels are conditionally mounted. A registry-level `when` would force unmount-on-close onto every surface — a behavior change. Each wrapper owns its own gating, replicating exactly what App.tsx did.
3. **Debug surfaces: behavior-preserving gate + lazy chunk.** The issue says "only mounted when dev-debug is on," but today `debugPanelOpen`/`feedDebugPanelOpen`/`proxyDebugPanelOpen`/`htmlDebugPanelOpen` open WITHOUT the dev-debug config (only `DevDebugPanel` requires `devDebugEnabled`). Gating all 5 on dev-debug would break those commands — contradicting "no behavior change." Resolution: keep today's per-panel gating, but wrap the whole group in `React.lazy` so debug-panel code leaves the production bundle/tree entirely unless a panel is actually opened. This satisfies the spirit (debug surfaces out of the prod render tree) without changing what users can open. If the stricter dev-debug gate is wanted, it's a one-line follow-up in `DebugSurfaces.tsx` — flagged in the PR description as an open question.
4. **`WorkspaceContext` instead of `workspace` props.** No workspace context exists today (`workspace/hook/context.ts` is types-only despite the name). The context value is the `useWorkspace` return object, which gets a fresh identity every App render — so consumers re-render whenever App renders, **exactly like today's prop drilling**. No regression, and surface wrappers become self-contained. Existing prop-taking components (TabBar, ReaderView, TileTree, …) keep their props — converting them is out of scope; only NEW wrapper files use the context.
5. **CommandPalette becomes self-contained.** Its ~76 props exist solely to assemble one `CommandContext` (`{workspace, ui, flags}`) that it relays to feature-owned command defs. The assembly moves inside the palette (store selectors + `useWorkspaceContext` + the new caffeinate/dev-debug stores). App's prop relay is deleted. The `CommandContext` type and every command definition are **untouched** — this keeps the diff disjoint from #394's future provider-enumeration command rewrite.
6. **App-local `useState` gets real homes.** `agentViewModePickerSessionId` → uiShell slice (it's a modal open-flag like every sibling). Caffeinate status/message → new `features/caffeinate/` store. `devDebugEnabled`/`sessionRecordingEnabled` → `features/debug/devDebugConfig.ts` store.
7. **DOM order within groups is preserved; group boundaries reorder three siblings** (`TiledDispatchCountOverlay` and the caffeinate toast move from between PathPicker and TileTabsModal into `<GlobalOverlays/>` just before the modals). All of these are `fixed`-position layers with explicit z-index; the manual pass (Task 13) verifies stacking. Every other sibling order is identical.

## File Structure (what exists at the end)

```
src/renderer/src/app/
  App.tsx                                   # ~120 lines: hooks + providers + shell + registry groups
  shell/
    index.ts                                # barrel: re-exports shell pieces + SetupGate (keeps App.tsx free of features/ imports)
    RestoreBanner.tsx                       # restore-status banner (verbatim)
    SettingsBar.tsx                         # AppearanceMenu + perf/caff buttons + PerformancePanel + SystemPerfHeader
    MainSurface.tsx                         # mode routing: Settings/Reader/Spotlight/GlobalEditorShell{TileTabs,Dispatch,TileTree,Welcome}
    WelcomeEmpty.tsx                        # moved out of App.tsx (verbatim)
  surfaces/
    types.ts                                # SurfaceEntry
    registry.tsx                            # modalSurfaces / overlaySurfaces / sidePanelSurfaces arrays
    GlobalModals.tsx  GlobalOverlays.tsx  SidePanels.tsx

src/renderer/src/workspace/
  WorkspaceContext.tsx                      # WorkspaceProvider + useWorkspaceContext
  hook/effects/useRenderedLeaseHygiene.ts   # root effects E8+E9 (terminal-mode + reader/spotlight/settings lease cleanup)

src/renderer/src/features/
  caffeinate/{store.ts, useCaffeinateSync.ts, surfaces/CaffeinateToastSurface.tsx}
  debug/{devDebugConfig.ts, useDebugAutosave.ts,
         surfaces/{DebugBundleNoteSurface.tsx, RecordingNoteSurface.tsx, DebugSurfaces.tsx, DebugSurfacesImpl.tsx}}
  settings/hooks/useThemeSync.ts
  global-editor/hooks/useAiWorkspaceOpenRequests.ts
  voice-dictation/{useDictationHotkeySync.ts, surfaces/VoiceDictationSurface.tsx}
  path-picker/{usePathPickerRequests.ts, surfaces/PathPickerSurface.tsx}
  command-palette/surfaces/CommandPaletteSurface.tsx
  workspace/surfaces/{TileTabsModalSurface.tsx, ReorderTabsSurface.tsx, BuryPanePromptSurface.tsx,
                      ViewPromptsSurface.tsx, PromptSearchSurface.tsx, AgentActivitySurface.tsx,
                      CloseOldAgentsSurface.tsx, BulkProviderSwitchSurface.tsx,
                      AgentViewModePickerSurface.tsx, RewindToPromptSurface.tsx,
                      TiledDispatchCountSurface.tsx, usePlacementOverlay.ts}
  dispatch-pin/surfaces/PinAgentsSurface.tsx
  usage/surfaces/UsageModalSurface.tsx
  git/surfaces/GitBarSurface.tsx
  worktrees/surfaces/WorktreesBarSurface.tsx
  agent-status/surfaces/AgentStatusPanelSurface.tsx
  remote/surfaces/RemotePanelSurface.tsx

src/renderer/src/app-state/uiShell/{types.ts, slice.ts}   # +agentViewModePickerSessionId
src/renderer/src/app-state/types.ts                        # +2 action signatures
```

---

### Task 1: Scaffolding — WorkspaceContext + empty surface registry wired into App

**Files:**
- Create: `src/renderer/src/workspace/WorkspaceContext.tsx`
- Create: `src/renderer/src/app/surfaces/types.ts`
- Create: `src/renderer/src/app/surfaces/registry.tsx`
- Create: `src/renderer/src/app/surfaces/GlobalModals.tsx`
- Create: `src/renderer/src/app/surfaces/GlobalOverlays.tsx`
- Create: `src/renderer/src/app/surfaces/SidePanels.tsx`
- Modify: `src/renderer/src/app/App.tsx` (wrap return in provider; mount empty groups)

**Interfaces:**
- Produces: `WorkspaceProvider({ workspace, children })`, `useWorkspaceContext(): Workspace`, `SurfaceEntry`, `modalSurfaces/overlaySurfaces/sidePanelSurfaces: SurfaceEntry[]`, `<GlobalModals/> <GlobalOverlays/> <SidePanels/>`. Every later task registers into these arrays.

- [ ] **Step 1: Write `WorkspaceContext.tsx`**

```tsx
import { createContext, useContext, type ReactNode } from 'react'
import type { Workspace } from '@renderer/workspace/workspaceStore'

// WHY this exists (issue #494): App.tsx was the only owner of the
// useWorkspace() hook value and therefore had to mount every feature
// surface itself, prop-drilling `workspace` into ~15 components. This
// context lets surface wrappers (app/surfaces/registry.tsx) be
// self-contained files that App never has to know about.
//
// Re-render semantics — deliberately unchanged from prop drilling: the
// context value is the object useWorkspace() returns, which has a fresh
// identity on every App render, so every consumer re-renders whenever
// App does. That is exactly what the prop-drilled components already
// did. Do NOT try to memoize the workspace object here to "optimize" —
// its methods close over current state and a stale snapshot is a
// correctness bug, not a perf win.
//
// NOTE for the remote client: this file must stay Electron-free (it is —
// pure React). The phone bundle never mounts WorkspaceProvider, so
// anything consuming useWorkspaceContext() is desktop-only by
// construction.
const WorkspaceContext = createContext<Workspace | null>(null)

export function WorkspaceProvider({
  workspace,
  children,
}: {
  workspace: Workspace
  children: ReactNode
}) {
  return <WorkspaceContext.Provider value={workspace}>{children}</WorkspaceContext.Provider>
}

export function useWorkspaceContext(): Workspace {
  const workspace = useContext(WorkspaceContext)
  if (!workspace) {
    // Loud failure beats a silent null: a surface rendered outside the
    // provider is a composition-root wiring bug, never a legitimate state.
    throw new Error('useWorkspaceContext must be used inside <WorkspaceProvider>')
  }
  return workspace
}
```

- [ ] **Step 2: Write `app/surfaces/types.ts`**

```ts
import type { ComponentType } from 'react'

// One global modal / overlay / side panel (issue #494). Entries are
// aggregated in app/surfaces/registry.tsx — the same
// per-feature-file + one-aggregate-array shape as the command registry
// (features/command-palette/registry.ts), chosen over side-effect
// self-registration because an explicit import list is grep-able and
// compiler-checked.
//
// WHY there is no `when(state)` gate here (deviation from the issue's
// sketch): mount semantics are load-bearing and differ per surface.
// Most modals are ALWAYS mounted and receive `open` as a prop (internal
// state — e.g. a half-typed search query — survives close/reopen);
// panels are conditionally mounted. A registry-level `when` would force
// unmount-on-close onto every surface and silently reset that state.
// Each wrapper owns its own gating, replicating exactly what App.tsx
// did before the extraction.
export type SurfaceEntry = {
  /** Stable id — React key + grep handle. */
  id: string
  /**
   * Fully self-contained: reads its own open-flag/actions from
   * useAppStore and the workspace from useWorkspaceContext(). Takes no
   * props by design — props would put App back in the wiring business.
   */
  Component: ComponentType
}
```

- [ ] **Step 3: Write `app/surfaces/registry.tsx`** (empty arrays for now; entries land in Tasks 5–10)

```tsx
import type { SurfaceEntry } from './types'

// The surface registry (issue #494). Adding a surface = write a wrapper
// in the owning feature's surfaces/ folder + add ONE import + ONE array
// entry here. App.tsx is never edited.
//
// ORDER MATTERS within each array: it is the DOM sibling order, which
// decides paint order when z-indexes tie. The order below is the exact
// order App.tsx rendered these surfaces before the extraction — keep new
// entries at the END unless you have a stacking reason and write it down.

/** Rendered at the app root, after the overlays. */
export const modalSurfaces: SurfaceEntry[] = []

/** Rendered at the app root, after the main row, before the modals. */
export const overlaySurfaces: SurfaceEntry[] = []

/** Rendered INSIDE the main flex row, as siblings after <main>. */
export const sidePanelSurfaces: SurfaceEntry[] = []
```

- [ ] **Step 4: Write the three group components.** `GlobalModals.tsx`:

```tsx
import { modalSurfaces } from './registry'

export function GlobalModals() {
  return (
    <>
      {modalSurfaces.map(entry => (
        <entry.Component key={entry.id} />
      ))}
    </>
  )
}
```

`GlobalOverlays.tsx` and `SidePanels.tsx` are identical over `overlaySurfaces` / `sidePanelSurfaces` with component names `GlobalOverlays` / `SidePanels` (write all three files — 10 lines each, no shared abstraction needed; three map-calls do not justify a factory).

- [ ] **Step 5: Wire into App.tsx.** Wrap the returned tree in the provider and mount the (empty) groups at their permanent positions:
  - `import { WorkspaceProvider } from '@renderer/workspace/WorkspaceContext'` and the three groups from `@renderer/app/surfaces/...`.
  - Wrap the current root `<div className="relative h-screen ...">` in `<WorkspaceProvider workspace={workspace}>…</WorkspaceProvider>`.
  - Inside the main flex row `<div className="flex-1 min-h-0 min-w-0 flex overflow-hidden">`, add `<SidePanels />` immediately after the last debug panel block (before the row's closing tag).
  - After the row's closing `</div>`, add `<GlobalOverlays />` immediately before `<VoiceDictationOverlay />`, and `<GlobalModals />` immediately after the second `<DebugBundleNotePrompt …/>` closing tag (i.e. among the modals — the exact insertion point stops mattering as tasks migrate entries; what matters is overlays-group before modals-group, both after the main row).

- [ ] **Step 6: Verify + commit**

```bash
npx tsc -b && npm run test:renderer
git add src/renderer/src/workspace/WorkspaceContext.tsx src/renderer/src/app/surfaces/ src/renderer/src/app/App.tsx
git commit -m "refactor(app-shell): scaffold surface registry + workspace context (#494)"
```
Expected: tsc exits 0; renderer suite green (no App-level tests exist).

---

### Task 2: Move `agentViewModePickerSessionId` into the uiShell slice

**Files:**
- Modify: `src/renderer/src/app-state/uiShell/types.ts` (state field)
- Modify: `src/renderer/src/app-state/uiShell/slice.ts` (initial value + 2 actions)
- Modify: `src/renderer/src/app-state/types.ts` (action signatures on `UiShellSlice`)
- Modify: `src/renderer/src/app/App.tsx` (drop the `useState`, read store)

**Interfaces:**
- Produces: `agentViewModePickerSessionId: SessionId | null`, `openAgentViewModePicker(sessionId: SessionId): void`, `closeAgentViewModePicker(): void` on `useAppStore`. Task 6's `AgentViewModePickerSurface` and Task 10's palette assembly consume these.

- [ ] **Step 1: Add the state field** to `UiShellState` in `uiShell/types.ts`, next to the other per-session modal fields (`rewindPromptSessionId` at ~line 177):

```ts
/**
 * Per-session agent view-mode picker modal. Was App.tsx-local useState
 * before #494 — moved into uiShell so the command palette and the
 * surface registry can drive it without App threading a callback. Same
 * open/close shape as rewindPromptSessionId: non-null = open for that
 * session.
 */
agentViewModePickerSessionId: SessionId | null
```

- [ ] **Step 2: Add actions** in `uiShell/slice.ts` (initial value `agentViewModePickerSessionId: null` in the initial-state block; actions next to `openRewindPrompt`/`closeRewindPrompt`, following the file's devtools-label convention):

```ts
openAgentViewModePicker: sessionId =>
  set({ agentViewModePickerSessionId: sessionId }, undefined, 'uiShell/openAgentViewModePicker'),
closeAgentViewModePicker: () =>
  set({ agentViewModePickerSessionId: null }, undefined, 'uiShell/closeAgentViewModePicker'),
```

- [ ] **Step 3: Add signatures** to `UiShellSlice` in `app-state/types.ts` next to the rewind pair:

```ts
openAgentViewModePicker: (sessionId: SessionId) => void
closeAgentViewModePicker: () => void
```

- [ ] **Step 4: Rewire App.tsx.** Delete the `const [agentViewModePickerSessionId, setAgentViewModePickerSessionId] = useState<SessionId | null>(null)` line and the `openAgentViewModePicker`/`closeAgentViewModePicker` `useCallback`s; replace with store selectors (`useAppStore(state => state.agentViewModePickerSessionId)` etc.). The `<AgentViewModePickerModal>` JSX and the `CommandPalette` prop keep working unchanged.

- [ ] **Step 5: Verify + commit**

```bash
npx tsc -b && npm run test:renderer
git add src/renderer/src/app-state/ src/renderer/src/app/App.tsx
git commit -m "refactor(app-shell): agent view-mode picker state into uiShell slice (#494)"
```

---

### Task 3: Caffeinate feature — store, sync hook, toast surface

**Files:**
- Create: `src/renderer/src/features/caffeinate/store.ts`
- Create: `src/renderer/src/features/caffeinate/useCaffeinateSync.ts`
- Create: `src/renderer/src/features/caffeinate/surfaces/CaffeinateToastSurface.tsx`
- Modify: `src/renderer/src/app/surfaces/registry.tsx` (register toast in `overlaySurfaces`)
- Modify: `src/renderer/src/app/App.tsx` (drop 2 useStates + 3 effects + toggle callback + toast JSX; read store for the settings-bar button and palette props)

**Interfaces:**
- Produces: `useCaffeinateStore` with `{ status: CaffeinateStatus | null, message: string | null, toggle(): Promise<void>, dismissMessage(): void }`; `useCaffeinateSync(): void`. Task 10 (palette flags `caffeinateActive`/`caffeinateSupported`, ui `toggleCaffeinate`) and Task 12 (`SettingsBar`) consume the store.

- [ ] **Step 1: Write `store.ts`**

```ts
import { create } from 'zustand'
import type { CaffeinateStatus } from '@preload/index'

// Caffeinate state was two App.tsx-local useStates (#494). It gets its
// own feature store because THREE unrelated consumers need it — the
// settings-bar button, the command palette (active/supported flags +
// toggle), and the toast overlay — and none of them should have to meet
// in a shared parent to see the same status.
//
// Source of truth is main (caffeinate.ts IPC); this store is a mirror
// hydrated by useCaffeinateSync. `message` is transient UI feedback
// (auto-dismissed by the toast surface), `status` is durable.
type CaffeinateState = {
  status: CaffeinateStatus | null
  message: string | null
  setStatus: (status: CaffeinateStatus) => void
  setMessage: (message: string | null) => void
  dismissMessage: () => void
  toggle: () => Promise<void>
}

export const useCaffeinateStore = create<CaffeinateState>()((set) => ({
  status: null,
  message: null,
  setStatus: status => set({ status }),
  setMessage: message => set({ message }),
  dismissMessage: () => set({ message: null }),
  toggle: async () => {
    try {
      const result = await window.api.toggleCaffeinate()
      set({ status: result.status, message: result.message })
    } catch (err) {
      set({ message: err instanceof Error ? err.message : 'Could not toggle caffeinate.' })
    }
  },
}))
```

- [ ] **Step 2: Write `useCaffeinateSync.ts`** — the initial-fetch + subscription effect, moved verbatim from App.tsx:225-251 (keep the unsupported-fallback object exactly):

```ts
import { useEffect } from 'react'
import { useCaffeinateStore } from './store'

// Root effect extracted from App.tsx (#494). Called ONCE from the
// composition root — it hydrates the store and keeps it subscribed to
// main's caffeinate:state-changed pushes. Mounting it twice would
// double-subscribe (harmless but wasteful); there is no ref-count
// because the composition root is its only intended caller.
export function useCaffeinateSync(): void {
  useEffect(() => {
    let cancelled = false
    void window.api.getCaffeinateStatus()
      .then(status => {
        if (!cancelled) useCaffeinateStore.getState().setStatus(status)
      })
      .catch(() => {
        if (!cancelled) {
          useCaffeinateStore.getState().setStatus({
            supported: false,
            active: false,
            pid: null,
            startedAt: null,
            command: [],
            message: 'Could not read caffeinate status.',
          })
        }
      })
    const off = window.api.onCaffeinateStateChanged(status => {
      useCaffeinateStore.getState().setStatus(status)
      useCaffeinateStore.getState().setMessage(status.message)
    })
    return () => {
      cancelled = true
      off()
    }
  }, [])
}
```

- [ ] **Step 3: Write `surfaces/CaffeinateToastSurface.tsx`** — the toast JSX from App.tsx:955-969 plus the 5s auto-dismiss effect from App.tsx:265-269 (the timer moves WITH the toast because it is the toast's lifecycle, not the app's):

```tsx
import { useEffect } from 'react'
import { useCaffeinateStore } from '../store'

export function CaffeinateToastSurface() {
  const message = useCaffeinateStore(state => state.message)
  const dismissMessage = useCaffeinateStore(state => state.dismissMessage)

  useEffect(() => {
    if (!message) return
    const timer = window.setTimeout(() => dismissMessage(), 5000)
    return () => window.clearTimeout(timer)
  }, [dismissMessage, message])

  if (!message) return null
  return (
    <div
      role="status"
      className="
        fixed bottom-3 right-3 z-50 max-w-[360px]
        border border-border bg-surface-hi px-3 py-2
        text-[11px] leading-snug text-ink shadow-lg
      "
    >
      <div className="font-semibold uppercase tracking-wide text-muted">
        Caffeinate
      </div>
      <div>{message}</div>
    </div>
  )
}
```

- [ ] **Step 4: Register + rewire.** In `registry.tsx` add `{ id: 'caffeinate-toast', Component: CaffeinateToastSurface }` to `overlaySurfaces`. In App.tsx: delete the two caffeinate useStates, the fetch/subscribe effect, the auto-dismiss effect, the `toggleCaffeinate` callback, and the toast JSX; the settings-bar button and the palette props read `useCaffeinateStore(state => state.status)` / `.toggle` for now (they move out of App in Tasks 10/12). Delete the now-unused `CaffeinateStatus` import.

- [ ] **Step 5: Verify + commit**

```bash
npx tsc -b && npm run test:renderer
git add src/renderer/src/features/caffeinate/ src/renderer/src/app/
git commit -m "refactor(app-shell): extract caffeinate feature store + toast surface (#494)"
```

---

### Task 4: Dev-debug config store + sync hook

**Files:**
- Create: `src/renderer/src/features/debug/devDebugConfig.ts`
- Modify: `src/renderer/src/app/App.tsx` (drop 2 useStates + 1 effect; read store)

**Interfaces:**
- Produces: `useDevDebugConfig` store with `{ enabled: boolean, sessionRecordingEnabled: boolean }` and `useDevDebugConfigSync(): void`. Consumed by Task 9 (`DevDebugPanel` gate) and Task 10 (palette flags `devDebugEnabled`/`sessionRecordingEnabled`).

- [ ] **Step 1: Write `devDebugConfig.ts`** (store + sync hook in one file — they are one concern and nothing else will ever import them separately):

```ts
import { useEffect } from 'react'
import { create } from 'zustand'

// Mirror of main's DevDebugConfig (#494 — was two App.tsx useStates).
// Read once at boot; main does not push updates (changing the config
// requires an app restart), so there is no subscription — just the
// one-shot hydrate. Defaults are false so the debug affordances stay
// hidden if the IPC probe fails: fail-closed is the right direction for
// developer-only surfaces.
type DevDebugConfigState = {
  enabled: boolean
  /** Gates the Attach-Recording-Note command (plan §7b). */
  sessionRecordingEnabled: boolean
}

export const useDevDebugConfig = create<DevDebugConfigState>()(() => ({
  enabled: false,
  sessionRecordingEnabled: false,
}))

// Root effect extracted from App.tsx. Call once from the composition root.
export function useDevDebugConfigSync(): void {
  useEffect(() => {
    let cancelled = false
    void window.api.getDevDebugConfig()
      .then(config => {
        if (cancelled) return
        useDevDebugConfig.setState({
          enabled: config.enabled,
          sessionRecordingEnabled: config.sessionRecordingEnabled,
        })
      })
      .catch(() => {
        if (cancelled) return
        useDevDebugConfig.setState({ enabled: false, sessionRecordingEnabled: false })
      })
    return () => {
      cancelled = true
    }
  }, [])
}
```

- [ ] **Step 2: Rewire App.tsx.** Delete the `devDebugEnabled`/`sessionRecordingEnabled` useStates and their hydrate effect; call `useDevDebugConfigSync()` at the top of App and read `useDevDebugConfig(state => state.enabled)` / `.sessionRecordingEnabled` where the old locals were used (DevDebugPanel gate + palette props — both migrate away later).

- [ ] **Step 3: Verify + commit**

```bash
npx tsc -b && npm run test:renderer
git add src/renderer/src/features/debug/devDebugConfig.ts src/renderer/src/app/App.tsx
git commit -m "refactor(app-shell): dev-debug config into feature store (#494)"
```

---

### Task 5: Path-picker flow — requests hook + surface wrapper

**Files:**
- Create: `src/renderer/src/features/path-picker/usePathPickerRequests.ts`
- Create: `src/renderer/src/features/path-picker/surfaces/PathPickerSurface.tsx`
- Modify: `src/renderer/src/app/surfaces/registry.tsx` (register in `modalSurfaces`)
- Modify: `src/renderer/src/app/App.tsx` (drop prefill effect, accept/resume callbacks, `pathPickerDefaultedRef`, `<PathPickerModal>` JSX; keep `onNewTabRequest`/`onResumeRequest` via the new hook)

**Interfaces:**
- Consumes: `useWorkspaceContext()` (Task 1).
- Produces: `usePathPickerRequests(): { onNewTabRequest: () => void, onResumeRequest: (defaultCwd: string) => void }`. Consumed by App (TabBar, `useKeybinds`), Task 10 (palette ui), Task 12 (`MainSurface` → WelcomeEmpty).

- [ ] **Step 1: Write `usePathPickerRequests.ts`**

```ts
import { useCallback } from 'react'
import { useAppStore } from '@renderer/app-state/hooks'

// The "open the new-tab / resume picker" entry points, extracted from
// App.tsx (#494). Both flows share the PathPickerModal; the difference
// is only whether an explicit default cwd seeds the input.
export function usePathPickerRequests(): {
  onNewTabRequest: () => void
  onResumeRequest: (defaultCwd: string) => void
} {
  const openPathPicker = useAppStore(state => state.openPathPicker)
  const setPathPickerDefault = useAppStore(state => state.setPathPickerDefault)

  // New tab flow: show the path modal. On accept the surface wrapper
  // calls workspace.newTab with the expanded absolute path and closes.
  const onNewTabRequest = useCallback(() => {
    openPathPicker()
  }, [openPathPicker])

  // Resume flow: same modal as new tab, but the default value is the
  // currently-focused tab's cwd so the resume list for that cwd is
  // visible immediately. This is the "continue where I was" shortcut.
  const onResumeRequest = useCallback(
    (defaultCwd: string) => {
      if (defaultCwd) {
        // Pre-fill with the current tab's cwd, bypassing the effect in
        // PathPickerSurface that normally fills from the active tab —
        // this is a direct-to-resume flow and the default MUST reflect
        // where the user is standing.
        setPathPickerDefault(defaultCwd)
      }
      openPathPicker(defaultCwd)
    },
    [openPathPicker, setPathPickerDefault],
  )

  return { onNewTabRequest, onResumeRequest }
}
```

- [ ] **Step 2: Write `surfaces/PathPickerSurface.tsx`.** This owns the pre-fill effect (App.tsx:381-420 verbatim, including the WHY comments about not re-syncing while visible and the active-tab-over-global-walk rationale) and the accept/resume handlers (App.tsx:445-463 verbatim, including the resume-reuses-newTab comment):

```tsx
import { useCallback, useEffect, useRef } from 'react'
import type { AgentProviderKind } from '@shared/types/providerKind'
import { PathPickerModal } from '@renderer/features/path-picker/ui/PathPickerModal'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'
import { resolveTabSessions } from '@renderer/workspace/queries'

export function PathPickerSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.pathPickerOpen)
  const defaultValue = useAppStore(state => state.pathPickerDefault)
  const closePathPicker = useAppStore(state => state.closePathPicker)
  const setPathPickerDefault = useAppStore(state => state.setPathPickerDefault)
  const defaultedRef = useRef(false)

  // Pre-fill the path input once per modal open. Do not keep syncing
  // while the modal is visible: newTab/resume mutates workspace
  // sessions before the modal closes, and re-syncing here resets the
  // picker mid-submit. Also preserve explicit defaults from the
  // resume shortcut.
  useEffect(() => {
    // <MOVE App.tsx:381-420 body VERBATIM, renaming
    //  pathPickerDefaultedRef -> defaultedRef,
    //  pathPickerOpen -> open, pathPickerDefault -> defaultValue.
    //  Keep the resolveTabSessions active-tab comment block intact.>
  }, [defaultValue, open, setPathPickerDefault, workspace.activeTab, workspace.state])

  const onAccept = useCallback(
    async (cwd: string, provider?: AgentProviderKind) => {
      await workspace.newTab(cwd, undefined, provider)
      closePathPicker()
    },
    [closePathPicker, workspace],
  )

  const onResume = useCallback(
    async (cwd: string, sessionId: string, provider: AgentProviderKind) => {
      // Resume reuses newTab's plumbing — same workspace entry, same
      // tile tree shape — but passes the resume id through to the
      // spawn call so main spawns the selected provider with its
      // provider-native resume command.
      await workspace.newTab(cwd, sessionId, provider)
      closePathPicker()
    },
    [closePathPicker, workspace],
  )

  return (
    <PathPickerModal
      open={open}
      defaultValue={defaultValue}
      onCancel={closePathPicker}
      onAccept={onAccept}
      onResume={onResume}
    />
  )
}
```
(The one `<MOVE …VERBATIM>` marker above is an instruction to the implementer to relocate existing code, not to invent any — the body already exists at App.tsx:381-420 and this plan intentionally does not fork it, so the file cannot drift from the plan.)

- [ ] **Step 3: Register + rewire.** Registry: `{ id: 'path-picker', Component: PathPickerSurface }` first in `modalSurfaces` (order note: palette gets prepended before it in Task 10 — final modal order is command-palette, path-picker, then Task 6/7 entries in App's original order). App.tsx: delete the prefill effect, `pathPickerDefaultedRef`, `onPathPickerAccept`, `onPathPickerResume`, the `<PathPickerModal>` JSX and import; replace the `onNewTabRequest`/`onResumeRequest` callbacks with `const { onNewTabRequest, onResumeRequest } = usePathPickerRequests()`.

- [ ] **Step 4: Verify + commit**

```bash
npx tsc -b && npm run test:renderer
git add src/renderer/src/features/path-picker/ src/renderer/src/app/
git commit -m "refactor(app-shell): path-picker flow into feature surface (#494)"
```

---

### Task 6: Workspace-feature modal wrappers (11 surfaces)

**Files:**
- Create: `src/renderer/src/features/workspace/surfaces/{TileTabsModalSurface,ReorderTabsSurface,BuryPanePromptSurface,ViewPromptsSurface,PromptSearchSurface,AgentActivitySurface,CloseOldAgentsSurface,BulkProviderSwitchSurface,AgentViewModePickerSurface,RewindToPromptSurface}.tsx`
- Create: `src/renderer/src/features/dispatch-pin/surfaces/PinAgentsSurface.tsx`
- Modify: `src/renderer/src/app/surfaces/registry.tsx`
- Modify: `src/renderer/src/app/App.tsx` (delete the 11 JSX blocks + their imports + `pinAgentsRows` memo + `buriedPromptMeta` + `onTileTabsRequest`)

**Interfaces:**
- Consumes: `useWorkspaceContext()`, store actions (incl. Task 2's view-mode picker pair).
- Produces: 11 registry entries. Task 10 removes the palette's need for `onTileTabsRequest` by inlining the same derivation.

Every wrapper follows the same shape as `UsageModalSurface` below (Task 7 shows it): read own flags/actions from `useAppStore`, workspace from context, render the existing modal component **always-mounted with `open`**, exactly as App did. Complete code for each:

- [ ] **Step 1: `TileTabsModalSurface.tsx`**

```tsx
import { TileTabsModal } from '@renderer/features/tile-tabs/ui/TileTabsModal'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

export function TileTabsModalSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.tileTabsModalOpen)
  const initialSelectedIds = useAppStore(state => state.tileTabsInitialSelectedIds)
  const close = useAppStore(state => state.closeTileTabsModal)
  return (
    <TileTabsModal
      open={open}
      tabs={workspace.state.tabs.map(tab => ({ id: tab.id, title: tab.title }))}
      initialSelectedIds={initialSelectedIds}
      onCancel={close}
      onConfirm={tabIds => {
        workspace.openTileTabs(tabIds)
        close()
      }}
    />
  )
}
```
(File location note: the wrapper lives in `features/workspace/surfaces/` even though `TileTabsModal` is `features/tile-tabs/` UI — the *surface* is a workspace-level concern (which tabs to tile). If you'd rather colocate with tile-tabs, that's fine too; pick one and keep the registry import honest. Same judgment call applies to none of the other ten — they wrap their own feature's UI.)

- [ ] **Step 2: `ReorderTabsSurface.tsx`**

```tsx
import { ReorderTabsModal } from '@renderer/features/workspace/ui/ReorderTabsModal'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

export function ReorderTabsSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.reorderTabsOpen)
  const close = useAppStore(state => state.closeReorderTabs)
  return (
    <ReorderTabsModal
      open={open}
      tabs={workspace.state.tabs.map(tab => ({ id: tab.id, title: tab.title }))}
      activeTabId={workspace.state.activeTabId}
      onCancel={close}
      onConfirm={tabIds => {
        workspace.reorderTabs(tabIds)
        close()
      }}
    />
  )
}
```

- [ ] **Step 3: `PinAgentsSurface.tsx`** — takes the entire `pinAgentsRows` useMemo (App.tsx:507-564) with ALL of its ordering/exclusion comments verbatim. Moving the memo into the wrapper means it recomputes only when this surface re-renders instead of on every App render — strictly better, same values:

```tsx
import { useMemo } from 'react'
import { PinAgentsModal, type PinAgentsModalRow } from '@renderer/features/dispatch-pin/PinAgentsModal'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'
import { resolveTabSessions } from '@renderer/workspace/queries'
import type { SessionId, TabId } from '@renderer/workspace/types'

export function PinAgentsSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.pinAgentsOpen)
  const close = useAppStore(state => state.closePinAgents)
  const { state } = workspace

  const rows = useMemo<PinAgentsModalRow[]>(() => {
    // <MOVE App.tsx:507-558 memo body VERBATIM, including the
    //  pinned-first ordering, terminal-exclusion, and
    //  resolveTabSessions-owner-lookup comment blocks.>
  }, [state.detachedSessions, state.pinnedSessionIds, state.sessions, state.tabs])

  return (
    <PinAgentsModal
      open={open}
      rows={rows}
      initialSelectedIds={state.pinnedSessionIds}
      onCancel={close}
      onConfirm={ids => {
        workspace.setPinnedSessionIds(ids)
        close()
      }}
    />
  )
}
```

- [ ] **Step 4: `BuryPanePromptSurface.tsx`** — absorbs the `buriedPromptMeta` derivation (App.tsx:565-567) and the title/description construction (App.tsx:1004-1017):

```tsx
import { BuryPanePrompt } from '@renderer/features/workspace/ui/BuryPanePrompt'
import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

export function BuryPanePromptSurface() {
  const workspace = useWorkspaceContext()
  const sessionId = useAppStore(state => state.buryPromptSessionId)
  const close = useAppStore(state => state.closeBuryPrompt)
  const meta = sessionId ? workspace.state.sessions[sessionId] ?? null : null
  return (
    <BuryPanePrompt
      open={sessionId !== null && meta !== null}
      title={
        meta
          ? `${meta.kind ?? DEFAULT_PROVIDER} · ${meta.cwd.split('/').filter(Boolean).pop() ?? meta.cwd}`
          : ''
      }
      description={meta?.cwd ?? ''}
      onCancel={close}
      onConfirm={note => {
        if (!sessionId) return
        workspace.buryFocused(note, sessionId)
      }}
    />
  )
}
```

- [ ] **Step 5: `ViewPromptsSurface.tsx`, `PromptSearchSurface.tsx`, `AgentActivitySurface.tsx`, `CloseOldAgentsSurface.tsx`, `BulkProviderSwitchSurface.tsx`, `RewindToPromptSurface.tsx`, `AgentViewModePickerSurface.tsx`** — all seven are the same mechanical pattern (store flag + close action + workspace context → existing component). Write each file completely; they differ only in names/props. Two representative complete files, the rest map 1:1 from the App.tsx JSX being deleted:

```tsx
// ViewPromptsSurface.tsx
import { ViewPromptsModal } from '@renderer/features/workspace/ui/ViewPromptsModal'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

export function ViewPromptsSurface() {
  const workspace = useWorkspaceContext()
  const sessionId = useAppStore(state => state.viewPromptsSessionId)
  const close = useAppStore(state => state.closeViewPrompts)
  return (
    <ViewPromptsModal
      open={sessionId !== null}
      sessionId={sessionId}
      workspace={workspace}
      onClose={close}
    />
  )
}
```

```tsx
// AgentViewModePickerSurface.tsx (uses Task 2's slice state)
import { AgentViewModePickerModal } from '@renderer/features/workspace/ui/AgentViewModePickerModal'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

export function AgentViewModePickerSurface() {
  const workspace = useWorkspaceContext()
  const sessionId = useAppStore(state => state.agentViewModePickerSessionId)
  const close = useAppStore(state => state.closeAgentViewModePicker)
  const agentViewMode = useAppStore(state => state.settings.agentViewMode)
  return (
    <AgentViewModePickerModal
      open={sessionId !== null}
      sessionId={sessionId}
      workspace={workspace}
      globalMode={agentViewMode}
      onClose={close}
    />
  )
}
```
Prop sources for the remaining five (each mirrors its deleted App.tsx block exactly): `PromptSearchSurface` ← `promptSearchOpen`/`closePromptSearch` + workspace; `AgentActivitySurface` ← `agentActivityOpen`/`closeAgentActivity` + workspace; `CloseOldAgentsSurface` ← `closeOldAgentsOpen`/`closeCloseOldAgents` + workspace; `BulkProviderSwitchSurface` ← `bulkProviderSwitchOpen`/`closeBulkProviderSwitch` + workspace; `RewindToPromptSurface` ← `rewindPromptSessionId` (`open={id !== null}`, `sessionId={id}`)/`closeRewindPrompt` + workspace.

- [ ] **Step 6: Register all 11** in `modalSurfaces` in App's original JSX order: `tile-tabs`, `reorder-tabs`, `pin-agents`, `bury-pane`, *(debug-note prompts land here in Task 7)*, `view-prompts`, `prompt-search`, `agent-activity`, `close-old-agents`, `bulk-provider-switch`, `agent-view-mode-picker`, `rewind-to-prompt`, *(usage lands in Task 7)*. Delete the 11 JSX blocks, their component imports, `pinAgentsRows`, `buriedPromptMeta`, and `onTileTabsRequest` from App.tsx (the palette still needs `onTileTabsRequest` until Task 10 — keep a local copy ONLY if tsc demands it, and delete it in Task 10).

- [ ] **Step 7: Verify + commit**

```bash
npx tsc -b && npm run test:renderer
git add src/renderer/src/features/workspace/surfaces/ src/renderer/src/features/dispatch-pin/surfaces/ src/renderer/src/app/
git commit -m "refactor(app-shell): workspace modals into surface registry (#494)"
```

---

### Task 7: Remaining root modals + overlays (usage, debug-note ×2, tiled-dispatch count, voice dictation)

**Files:**
- Create: `src/renderer/src/features/usage/surfaces/UsageModalSurface.tsx`
- Create: `src/renderer/src/features/debug/surfaces/DebugBundleNoteSurface.tsx`
- Create: `src/renderer/src/features/debug/surfaces/RecordingNoteSurface.tsx`
- Create: `src/renderer/src/features/workspace/surfaces/TiledDispatchCountSurface.tsx`
- Create: `src/renderer/src/features/voice-dictation/surfaces/VoiceDictationSurface.tsx`
- Modify: `src/renderer/src/app/surfaces/registry.tsx`
- Modify: `src/renderer/src/app/App.tsx` (delete the 5 JSX blocks + imports)

**Interfaces:** consumes Task 1 context; produces registry entries only.

- [ ] **Step 1: `UsageModalSurface.tsx`** — the canonical minimal wrapper:

```tsx
import { UsageModal } from '@renderer/features/usage/ui/UsageModal'
import { useAppStore } from '@renderer/app-state/hooks'

export function UsageModalSurface() {
  const open = useAppStore(state => state.usageModalOpen)
  const close = useAppStore(state => state.closeUsageModal)
  return <UsageModal open={open} onClose={close} />
}
```

- [ ] **Step 2: `DebugBundleNoteSurface.tsx`** — moves the onConfirm body (App.tsx:1019-1042) verbatim including the toast plumbing:

```tsx
import { DebugBundleNotePrompt } from '@renderer/features/debug/ui/DebugBundleNotePrompt'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

export function DebugBundleNoteSurface() {
  const workspace = useWorkspaceContext()
  const prompt = useAppStore(state => state.debugBundleNotePrompt)
  const close = useAppStore(state => state.closeDebugBundleNotePrompt)
  return (
    <DebugBundleNotePrompt
      open={prompt !== null}
      title={prompt?.title ?? ''}
      description={prompt?.description ?? ''}
      bundlePath={prompt?.bundlePath ?? ''}
      onCancel={close}
      onConfirm={note => {
        if (!prompt) return
        const trimmed = note.trim()
        close()
        if (!trimmed) return
        void window.api.addDebugBundleNote({
          bundlePath: prompt.bundlePath,
          note: trimmed,
        }).then(
          () => workspace.showPaneToast(prompt.sessionId, 'debug note saved', 3000),
          err => {
            const message = err instanceof Error ? err.message : String(err)
            workspace.showPaneToast(prompt.sessionId, `debug note failed: ${message}`, 5000)
          },
        )
      }}
    />
  )
}
```

- [ ] **Step 3: `RecordingNoteSurface.tsx`** — same shape over `recordingNotePrompt`/`closeRecordingNotePrompt` + `window.api.fillRecordingNote(prompt.sessionId, prompt.noteId, trimmed)`, keeping the App.tsx:1044-1048 comment block (reserved-marker semantics: cancel deliberately does NOT delete the marker) and the recording-specific labels (`heading="Attach Recording Note"`, `fieldLabel="Note"`, `placeholder="What did you see? (marks the exact recorded tick)"`, `description=""`, `bundlePath=""`).

- [ ] **Step 4: `TiledDispatchCountSurface.tsx`** — conditional mount, exactly as App did (App.tsx:948-953), keeping the app-surface WHY comment:

```tsx
import { TiledDispatchCountOverlay } from '@renderer/features/workspace/ui/TiledDispatchCountOverlay'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'

// Tiled Dispatch tile-count prompt. Rendered at the app root (fixed
// overlay) because the command is `app`-surface — it can be invoked
// from the grid, classic Dispatch, or an already-tiled layout.
export function TiledDispatchCountSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.tiledDispatchPromptOpen)
  const close = useAppStore(state => state.closeTiledDispatchPrompt)
  if (!open) return null
  return <TiledDispatchCountOverlay workspace={workspace} onClose={close} />
}
```

- [ ] **Step 5: `VoiceDictationSurface.tsx`** — `VoiceDictationOverlay` is already fully self-contained (App renders it bare). The wrapper is a one-liner that exists purely so the overlay is registry-listed like its siblings:

```tsx
import { VoiceDictationOverlay } from '@renderer/features/voice-dictation/ui/VoiceDictationOverlay'

export function VoiceDictationSurface() {
  return <VoiceDictationOverlay />
}
```

- [ ] **Step 6: Register + delete.** `overlaySurfaces` final order: `voice-dictation`, `tiled-dispatch-count`, `caffeinate-toast` (voice-dictation first — it rendered before the others in App). `modalSurfaces`: insert `debug-bundle-note` and `recording-note` between `bury-pane` and `view-prompts`; append `usage` last. Delete the five JSX blocks + imports from App.tsx (including the bare `<VoiceDictationOverlay />`).

- [ ] **Step 7: Verify + commit**

```bash
npx tsc -b && npm run test:renderer
git add src/renderer/src/features/ src/renderer/src/app/
git commit -m "refactor(app-shell): remaining modals + overlays into surface registry (#494)"
```

---

### Task 8: Side panels (GitBar, WorktreesBar, AgentStatusPanel, RemotePanel)

**Files:**
- Create: `src/renderer/src/features/git/surfaces/GitBarSurface.tsx`
- Create: `src/renderer/src/features/worktrees/surfaces/WorktreesBarSurface.tsx`
- Create: `src/renderer/src/features/agent-status/surfaces/AgentStatusPanelSurface.tsx`
- Create: `src/renderer/src/features/remote/surfaces/RemotePanelSurface.tsx`
- Modify: `src/renderer/src/app/surfaces/registry.tsx` (`sidePanelSurfaces`)
- Modify: `src/renderer/src/app/App.tsx` (delete the 4 conditional blocks + imports)

**Interfaces:** consumes `useWorkspaceContext()` + `commandTargetSessionId` selector; produces registry entries.

These four are **conditionally mounted** (`{flag && <X/>}` in App) — the wrappers must return `null` when closed, NOT render with an `open` prop. They render inside the main flex row, so they are `sidePanelSurfaces` entries (the `<SidePanels/>` group from Task 1 sits exactly where the old blocks were).

- [ ] **Step 1: `GitBarSurface.tsx`**

```tsx
import { GitBar } from '@renderer/features/git/ui/GitBar'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'

export function GitBarSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.gitBarOpen)
  const toggle = useAppStore(state => state.toggleGitBar)
  if (!open) return null
  const targetId = commandTargetSessionId(workspace)
  return (
    <GitBar
      cwd={targetId ? workspace.state.sessions[targetId]?.cwd ?? null : null}
      onClose={toggle}
    />
  )
}
```

- [ ] **Step 2: `WorktreesBarSurface.tsx`** — identical shape over `worktreesBarOpen`/`toggleWorktreesBar`, passing `workspace={workspace}` as the existing component requires alongside `cwd`/`onClose`.

- [ ] **Step 3: `AgentStatusPanelSurface.tsx`** — App's guard was `agentStatusPanelOpen && commandTargetId` (both must hold):

```tsx
import { AgentStatusPanel } from '@renderer/features/agent-status/ui/AgentStatusPanel'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'

export function AgentStatusPanelSurface() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.agentStatusPanelOpen)
  const close = useAppStore(state => state.closeAgentStatusPanel)
  if (!open) return null
  const targetId = commandTargetSessionId(workspace)
  if (!targetId) return null
  return <AgentStatusPanel sessionId={targetId} workspace={workspace} onClose={close} />
}
```

- [ ] **Step 4: `RemotePanelSurface.tsx`** — `remotePanelOpen`/`toggleRemotePanel`, `if (!open) return null`, `return <RemotePanel onClose={toggle} />`.

- [ ] **Step 5: Register** in `sidePanelSurfaces` in App's original order: `git-bar`, `worktrees-bar`, `agent-status-panel`, `remote-panel` (debug panels append after these in Task 9 — they rendered after RemotePanel in App). Delete the four blocks + imports from App.tsx.

- [ ] **Step 6: Verify + commit**

```bash
npx tsc -b && npm run test:renderer
git add src/renderer/src/features/ src/renderer/src/app/
git commit -m "refactor(app-shell): side panels into surface registry (#494)"
```

---

### Task 9: Debug surfaces group (5 panels, lazy-loaded)

**Files:**
- Create: `src/renderer/src/features/debug/surfaces/DebugSurfaces.tsx`
- Create: `src/renderer/src/features/debug/surfaces/DebugSurfacesImpl.tsx`
- Modify: `src/renderer/src/app/surfaces/registry.tsx` (append `debug-surfaces` to `sidePanelSurfaces`)
- Modify: `src/renderer/src/app/App.tsx` (delete the 5 debug-panel blocks + imports)

**Interfaces:**
- Consumes: `useWorkspaceContext()`, `useDevDebugConfig` (Task 4), `commandTargetSessionId`, `getEffectiveAgentSurface`.
- Produces: one registry entry (`debug-surfaces`).

- [ ] **Step 1: Write `DebugSurfaces.tsx`** — the gate + lazy boundary:

```tsx
import { Suspense, lazy } from 'react'
import { useAppStore } from '@renderer/app-state/hooks'

// Issue #494 wants debug surfaces "out of the production render tree."
// We deliberately did NOT adopt the issue's stricter sketch (gate all
// five panels on the dev-debug config): today debugPanelOpen /
// feedDebugPanelOpen / proxyDebugPanelOpen / htmlDebugPanelOpen open
// WITHOUT dev-debug (only DevDebugPanel requires it), and this refactor
// is behavior-preserving. Instead the whole group is a lazy chunk that
// is not even fetched until a panel flag first turns on — debug code
// leaves the prod tree AND the initial bundle, and users keep the exact
// panel access they have today. If a hard dev-debug gate is ever
// wanted, it is one `useDevDebugConfig` check added right here.
const DebugSurfacesImpl = lazy(() =>
  import('./DebugSurfacesImpl').then(m => ({ default: m.DebugSurfacesImpl })),
)

export function DebugSurfaces() {
  const anyOpen = useAppStore(
    state =>
      state.debugPanelOpen ||
      state.feedDebugPanelOpen ||
      state.proxyDebugPanelOpen ||
      state.htmlDebugPanelOpen ||
      state.devDebugPanelOpen,
  )
  if (!anyOpen) return null
  // fallback={null}: these are side panels; a flash of nothing for one
  // frame while the chunk loads is invisible next to the panel's own
  // data fetch.
  return (
    <Suspense fallback={null}>
      <DebugSurfacesImpl />
    </Suspense>
  )
}
```

- [ ] **Step 2: Write `DebugSurfacesImpl.tsx`** — five wrappers in App's original order, each replicating its exact App.tsx guard. Complete code (this is the whole file):

```tsx
import { DEFAULT_PROVIDER } from '@shared/types/providerKind'
import { DebugPanel } from '@renderer/features/debug/ui/DebugPanel'
import { FeedDebugPanel } from '@renderer/features/debug/ui/FeedDebugPanel'
import { ProxyDebugPanel } from '@renderer/features/debug/ui/ProxyDebugPanel'
import { HtmlDebugPanel } from '@renderer/features/debug/ui/HtmlDebugPanel'
import { DevDebugPanel } from '@renderer/features/debug/ui/DevDebugPanel'
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'
import { useDevDebugConfig } from '@renderer/features/debug/devDebugConfig'
import { commandTargetSessionId } from '@renderer/workspace/hook/selectors/commandTargetSessionId'
import { getEffectiveAgentSurface } from '@renderer/workspace/agentDisplayMode'

// The five debug side panels, one component per panel-flag, in the
// exact order App.tsx mounted them. All five need the command-target
// session; each also carries its original guard (e.g. DevDebugPanel
// additionally requires the dev-debug config — that gate predates #494
// and moves here untouched).
export function DebugSurfacesImpl() {
  const workspace = useWorkspaceContext()
  const debugPanelOpen = useAppStore(state => state.debugPanelOpen)
  const feedDebugPanelOpen = useAppStore(state => state.feedDebugPanelOpen)
  const proxyDebugPanelOpen = useAppStore(state => state.proxyDebugPanelOpen)
  const htmlDebugPanelOpen = useAppStore(state => state.htmlDebugPanelOpen)
  const devDebugPanelOpen = useAppStore(state => state.devDebugPanelOpen)
  const toggleDebugPanel = useAppStore(state => state.toggleDebugPanel)
  const toggleFeedDebugPanel = useAppStore(state => state.toggleFeedDebugPanel)
  const toggleProxyDebugPanel = useAppStore(state => state.toggleProxyDebugPanel)
  const toggleHtmlDebugPanel = useAppStore(state => state.toggleHtmlDebugPanel)
  const toggleDevDebugPanel = useAppStore(state => state.toggleDevDebugPanel)
  const agentViewMode = useAppStore(state => state.settings.agentViewMode)
  const devDebugEnabled = useDevDebugConfig(state => state.enabled)

  const targetId = commandTargetSessionId(workspace)
  if (!targetId) return null
  const kind = workspace.state.sessions[targetId]?.kind ?? DEFAULT_PROVIDER

  return (
    <>
      {debugPanelOpen && (
        <DebugPanel
          sessionId={targetId}
          runtime={workspace.getRuntime(targetId)}
          kind={kind}
          inlineRawTerminalDisabled={
            getEffectiveAgentSurface({
              kind,
              mode: agentViewMode,
              runtime: workspace.getRuntime(targetId),
            }) === 'terminal'
          }
          onClose={toggleDebugPanel}
        />
      )}
      {feedDebugPanelOpen && (
        <FeedDebugPanel
          sessionId={targetId}
          runtime={workspace.getRuntime(targetId)}
          kind={kind}
          onClose={toggleFeedDebugPanel}
        />
      )}
      {proxyDebugPanelOpen && (
        <ProxyDebugPanel sessionId={targetId} kind={kind} onClose={toggleProxyDebugPanel} />
      )}
      {htmlDebugPanelOpen && (
        <HtmlDebugPanel sessionId={targetId} kind={kind} onClose={toggleHtmlDebugPanel} />
      )}
      {devDebugEnabled && devDebugPanelOpen && (
        <DevDebugPanel
          sessionId={targetId}
          runtime={workspace.getRuntime(targetId)}
          kind={kind}
          workspace={workspace}
          onClose={toggleDevDebugPanel}
        />
      )}
    </>
  )
}
```

- [ ] **Step 3: Register + delete.** Append `{ id: 'debug-surfaces', Component: DebugSurfaces }` to `sidePanelSurfaces`. Delete the five panel blocks and their imports (plus `getEffectiveAgentSurface` import) from App.tsx.

- [ ] **Step 4: Verify + commit**

```bash
npx tsc -b && npm run test:renderer
git add src/renderer/src/features/debug/ src/renderer/src/app/
git commit -m "refactor(app-shell): debug panels into lazy surface group (#494)"
```

---

### Task 10: CommandPalette self-containment (delete the 70-prop relay)

**Files:**
- Modify: `src/renderer/src/features/command-palette/ui/CommandPalette.tsx` (Props shrink to `{}`; internal sourcing)
- Create: `src/renderer/src/features/command-palette/surfaces/CommandPaletteSurface.tsx`
- Modify: `src/renderer/src/app/surfaces/registry.tsx` (prepend `command-palette` to `modalSurfaces`)
- Modify: `src/renderer/src/app/App.tsx` (delete the entire `<CommandPalette …/>` JSX + ~40 now-unused store selector lines)

**Interfaces:**
- Consumes: `useWorkspaceContext()`, `useAppStore`, `useCaffeinateStore` (Task 3), `useDevDebugConfig` (Task 4), `usePathPickerRequests` (Task 5), `useGlobalEditorStore`.
- Produces: a props-less `<CommandPalette/>`. **`CommandContext` (types.ts:86-213) and every command definition file are untouched** — the assembly changes source, not shape. This keeps the diff disjoint from the future #394 command rewrite.

**WHY this is safe:** the palette's ~76 props are consumed in exactly one place — the `commandContext` useMemo at CommandPalette.tsx:379-538 — plus `open`/`onClose`/`workspace` used by the palette chrome itself. Nothing else in the file reads a prop. So the change is: delete the `Props` type, source every value from the stores/context inside the component, keep the useMemo (its dependency list now names the locally-selected values). Zustand selector subscriptions make the palette re-render on exactly the same state changes that used to re-render App and arrive as new props.

- [ ] **Step 1: Rewire CommandPalette.tsx internals.** At the top of the component replace the destructured props with:

```tsx
export function CommandPalette() {
  const workspace = useWorkspaceContext()
  const open = useAppStore(state => state.commandPaletteOpen)
  const onClose = useAppStore(state => state.closeCommandPalette)
  const settings = useAppStore(state => state.settings)
  const setSettings = useAppStore(state => state.setSettings)
  const { onNewTabRequest, onResumeRequest } = usePathPickerRequests()
  // …every uiShell action the old props carried, selected individually:
  // openViewPrompts, openPromptSearch, openAgentActivity,
  // openCloseOldAgents, openBulkProviderSwitch, openRewindPrompt,
  // openAgentViewModePicker (Task 2), openUsageModal, openPinAgents,
  // toggleGitBar, toggleWorktreesBar, toggleDebugPanel,
  // toggleFeedDebugPanel, toggleProxyDebugPanel, toggleHtmlDebugPanel,
  // toggleDevDebugPanel, openAgentStatusPanel, closeAgentStatusPanel,
  // toggleAgentStatusPanel, togglePerformancePanel, toggleRemotePanel,
  // toggleGlobalEditor, openReorderTabs, openSettingsPage,
  // openTileTabsModal, openTiledDispatchPrompt, openDispatchAttach,
  // openLinkedAgent, toggleCustomRendering, toggleStatusMode,
  // toggleWorktreeBadges — plus the open-flags the `flags` bucket
  // needs: gitBarOpen, worktreesBarOpen, debugPanelOpen,
  // feedDebugPanelOpen, proxyDebugPanelOpen, htmlDebugPanelOpen,
  // devDebugPanelOpen, agentStatusPanelOpen, performancePanelOpen,
  // globalEditorOpen.
  const caffeinateStatus = useCaffeinateStore(state => state.status)
  const toggleCaffeinate = useCaffeinateStore(state => state.toggle)
  const devDebugEnabled = useDevDebugConfig(state => state.enabled)
  const sessionRecordingEnabled = useDevDebugConfig(state => state.sessionRecordingEnabled)
  const fileTreeVisible = useGlobalEditorStore(state => state.fileTreeVisible)
  const toggleFileTreeVisible = useGlobalEditorStore(state => state.toggleFileTreeVisible)
```

- [ ] **Step 2: Rebuild the `commandContext` useMemo sources** (the `ui`/`flags` object literals keep their exact keys; only the right-hand sides change). The non-mechanical mappings, explicitly:

```tsx
// ui bucket — App-derived callbacks now built here:
onTileTabsRequest: () =>
  openTileTabsModal(
    workspace.tileTabs?.tabIds ?? (workspace.activeTab ? [workspace.activeTab.id] : []),
  ),
onReorderTabsRequest: openReorderTabs,
onSettingsRequest: openSettingsPage,
enterDispatchMode: workspace.enterDispatchMode,
enterGlobalDispatch: () =>
  workspace.setDispatchScope(
    workspace.dispatchMode?.scope === 'global' ? 'project' : 'global',
  ),
exitDispatchMode: workspace.exitDispatchMode,
setDangerousAgentsEnabled: enabled => setSettings({ dangerousAgentsEnabled: enabled }),
setAggressiveDebugPersistence: enabled => setSettings({ aggressiveDebugPersistence: enabled }),

// flags bucket — settings-derived:
customRenderingEnabled: settings.customRendering,
agentViewMode: settings.agentViewMode,
commandVisibilityOverrides: settings.commandVisibilityOverrides,
// Hard-coded false, moved from App.tsx:907-910: issue #249 shipped the
// per-command override mechanism only. A future "show hidden commands"
// affordance can flip this to reveal the full list in one shot.
showHiddenCommands: false,
statusModeEnabled: settings.showStatusMode,
worktreeBadgesEnabled: settings.showWorktreeBadges,
dangerousAgentsEnabled: settings.dangerousAgentsEnabled,
aggressiveDebugPersistenceEnabled: settings.aggressiveDebugPersistence,
caffeinateActive: caffeinateStatus?.active === true,
caffeinateSupported: caffeinateStatus?.supported !== false,
dispatchModeEnabled: workspace.dispatchMode !== null,
globalDispatchEnabled: workspace.dispatchMode?.scope === 'global',
```
Everything else in `ui`/`flags` maps 1:1 to the same-named store action/flag selected in Step 1. Update the useMemo dependency array to the new local names (tsc + the exhaustive-deps lint make omissions loud).

- [ ] **Step 3: Delete the `Props` type** (CommandPalette.tsx:72-147) and the destructuring; the component signature becomes `export function CommandPalette()`. Keep `open`/`onClose` semantics identical (early-return / dialog gating unchanged — only their source moved).

- [ ] **Step 4: Write `surfaces/CommandPaletteSurface.tsx`:**

```tsx
import { CommandPalette } from '@renderer/features/command-palette/ui/CommandPalette'

export function CommandPaletteSurface() {
  return <CommandPalette />
}
```

- [ ] **Step 5: Register + gut App.** Prepend `{ id: 'command-palette', Component: CommandPaletteSurface }` to `modalSurfaces` (it rendered before PathPicker in App). Delete the whole `<CommandPalette …/>` JSX block and its import from App.tsx, then delete every store selector line App kept only for palette props (roughly 40 of the selector lines at App.tsx:78-184 — tsc's `noUnusedLocals` flags each survivor; delete until clean). `toggleCommandPalette` stays — `useKeybinds` needs it.

- [ ] **Step 6: Verify + commit**

```bash
npx tsc -b && npm run test:renderer
git add src/renderer/src/features/command-palette/ src/renderer/src/app/
git commit -m "refactor(app-shell): self-contained command palette, delete 70-prop relay (#494)"
```

---

### Task 11: Remaining root effects → feature hooks

**Files:**
- Create: `src/renderer/src/features/settings/hooks/useThemeSync.ts`
- Create: `src/renderer/src/features/global-editor/hooks/useAiWorkspaceOpenRequests.ts`
- Create: `src/renderer/src/features/voice-dictation/useDictationHotkeySync.ts`
- Create: `src/renderer/src/workspace/hook/effects/useRenderedLeaseHygiene.ts`
- Create: `src/renderer/src/features/debug/useDebugAutosave.ts`
- Modify: `src/renderer/src/app/App.tsx` (delete 5 effect bodies + `workspaceRef`; call the named hooks)

**Interfaces:**
- Consumes: `Workspace` type (hygiene + autosave hooks take `workspace` as a parameter — they need the live object, and App owns it).
- Produces: `useThemeSync()`, `useAiWorkspaceOpenRequests()`, `useDictationHotkeySync()`, `useRenderedLeaseHygiene(workspace)`, `useDebugAutosave(workspace)`.

Every body moves **verbatim with its full comment block** — these comments encode hard-won invariants (the `readerMode`-not-`reader` typo history, the Terminal-mode hard-reset semantics, the autosave in-flight guard). Only the value sources change (store selectors instead of App locals).

- [ ] **Step 1: `useThemeSync.ts`** (owns App.tsx:194-197):

```ts
import { useEffect } from 'react'
import { useAppStore } from '@renderer/app-state/hooks'
import { applyTheme } from '@renderer/app-state/settings/theme'

// Theme is applied twice by design: once at settings-slice module load
// (pre-hydration default, no FOUC) and here on every settings change,
// which also mirrors the theme to main so the remote client's pages are
// served with matching colors. Desktop-only (window.api) — must never
// be imported from the shared feed subtree the phone bundle re-uses.
export function useThemeSync(): void {
  const settings = useAppStore(state => state.settings)
  useEffect(() => {
    applyTheme(settings)
    void window.api.remoteSetThemeSettings(settings)
  }, [settings])
}
```

- [ ] **Step 2: `useAiWorkspaceOpenRequests.ts`** (owns App.tsx:199-205):

```ts
import { useEffect } from 'react'
import { useAppStore } from '@renderer/app-state/hooks'
import { useGlobalEditorStore } from '@renderer/features/global-editor/store'

// Main pushes "open this AI workspace" requests (deep links, MCP);
// the renderer answers by opening the workspace in the global editor
// and revealing the editor. Lives in global-editor because that is the
// surface being opened — the subscription is just its doorbell.
export function useAiWorkspaceOpenRequests(): void {
  useEffect(() => {
    const off = window.api.onAiWorkspaceOpenRequest(request => {
      useGlobalEditorStore.getState().openAiWorkspace(request.workspaceId)
      useAppStore.getState().openGlobalEditor()
    })
    return off
  }, [])
}
```

- [ ] **Step 3: `useDictationHotkeySync.ts`** (owns App.tsx:271-283, comment verbatim):

```ts
import { useEffect } from 'react'
import { useAppStore } from '@renderer/app-state/hooks'

export function useDictationHotkeySync(): void {
  const dictationEnabled = useAppStore(state => state.settings.dictationEnabled)
  const dictationShortcut = useAppStore(state => state.settings.dictationShortcut)
  useEffect(() => {
    // The default dictation trigger is bare Fn, which Chromium does not expose
    // reliably to renderer keydown. Settings live in the renderer, but the
    // actual capture must live in main/native; keep this one-way sync here so
    // every pane shares the same OS listener while the focused pane decides
    // whether to consume the resulting press/release event.
    const binding = dictationEnabled ? dictationShortcut : ''
    void window.api.configureDictationHotkey({ binding }).then(result => {
      if (!result.ok) {
        console.warn('[dictation] hotkey registration failed:', result)
      }
    })
  }, [dictationEnabled, dictationShortcut])
}
```

- [ ] **Step 4: `useRenderedLeaseHygiene.ts`** — the two lease-cleanup effects (App.tsx:293-336) as one hook with two effects, signature `useRenderedLeaseHygiene(workspace: Workspace): void`, reading `settings.agentViewMode` and `settingsPageOpen` from the store. Move BOTH comment blocks verbatim — the Terminal-mode hard-reset rationale AND the `readerMode`-not-`reader` cross-app-audit history (that comment is the codebase's living memory of why the tsc gate exists). Placed under `workspace/hook/effects/` (new folder) because leases/pickers are workspace-runtime concerns, not a feature's; a header comment should note the folder's charter: *effects owned by the workspace layer that the composition root mounts once*. Deliberately NOT in `workspace/semantic/` or anywhere #493 is restructuring.

- [ ] **Step 5: `useDebugAutosave.ts`** — owns App.tsx:338-374 plus the `workspaceRef` mirror (App.tsx:286-291), because the ref exists solely so the autosave interval reads fresh workspace state without re-arming on every render (keep that WHY as a comment):

```ts
import { useEffect, useRef } from 'react'
import {
  AUTO_DEBUG_BUNDLE_INTERVAL_MS,
  autosaveActiveAgentDebugBundles,
} from '@renderer/features/debug/saveDebugBundle'
import { useAppStore } from '@renderer/app-state/hooks'
import type { Workspace } from '@renderer/workspace/workspaceStore'

export function useDebugAutosave(workspace: Workspace): void {
  // Ref mirror so the interval closure always reads the CURRENT
  // workspace without the effect re-arming (and re-baselining) on every
  // render — the interval must run on wall-clock cadence, not render
  // cadence.
  const workspaceRef = useRef(workspace)
  useEffect(() => {
    workspaceRef.current = workspace
  }, [workspace])

  const enabled = useAppStore(state => state.settings.aggressiveDebugPersistence)
  useEffect(() => {
    if (!enabled) return
    // <MOVE App.tsx:340-374 body VERBATIM: disposed/inFlight guards,
    //  saveAll(reason) incl. the beforeunload override, the immediate
    //  'autosave-enabled' baseline comment, interval + beforeunload
    //  registration and the three-way cleanup.>
  }, [enabled])
}
```

- [ ] **Step 6: Rewire App.** Delete the five effect bodies + `workspaceRef`; App's hook block becomes (final shape, lands fully in Task 12):

```tsx
useThemeSync()
useAiWorkspaceOpenRequests()
useDevDebugConfigSync()
useCaffeinateSync()
useDictationHotkeySync()
const workspace = useWorkspace(dangerousAgentsEnabled, useProxyStreaming, defaultWorkspaceMode)
useRenderedLeaseHygiene(workspace)
useDebugAutosave(workspace)
useKeybinds(workspace, onNewTabRequest, onResumeRequest, toggleCommandPalette)
```
Ordering constraint: the first five are workspace-independent and MUST stay above the `useWorkspace` call only for readability — hooks order just has to be unconditional and stable, and none of them depend on each other.

- [ ] **Step 7: Verify + commit**

```bash
npx tsc -b && npm run test:renderer
git add src/renderer/src/features/ src/renderer/src/workspace/hook/effects/ src/renderer/src/app/App.tsx
git commit -m "refactor(app-shell): root effects into feature-owned hooks (#494)"
```

---

### Task 12: Shell extraction — App.tsx to ~120 lines

**Files:**
- Create: `src/renderer/src/app/shell/RestoreBanner.tsx`
- Create: `src/renderer/src/app/shell/SettingsBar.tsx`
- Create: `src/renderer/src/app/shell/MainSurface.tsx`
- Create: `src/renderer/src/app/shell/WelcomeEmpty.tsx`
- Create: `src/renderer/src/app/shell/index.ts`
- Create: `src/renderer/src/features/workspace/surfaces/usePlacementOverlay.ts`
- Modify: `src/renderer/src/app/App.tsx` (final form below)

**Interfaces:**
- Consumes: everything previous tasks produced.
- Produces: `<RestoreBanner/>`, `<SettingsBar/>`, `<MainSurface onNewTabRequest={…}/>`, `usePlacementOverlay(): { open, attachIntent, linkedAgentParentId, close }`, and the `app/shell/index.ts` barrel (which also re-exports `SetupGate` so App.tsx has zero `@renderer/features/*` imports).

- [ ] **Step 1: `usePlacementOverlay.ts`** (create/attach/linked flows share one overlay shell — comment moves verbatim from App.tsx:136-138):

```ts
import { useCallback } from 'react'
import { useAppStore } from '@renderer/app-state/hooks'

// Create, attach, and linked-agent flows share the same overlay
// shell. The close handler clears every intent so re-opening one
// mode after another never inherits stale state from a sibling flow.
export function usePlacementOverlay() {
  const newAgentPlacementOpen = useAppStore(state => state.newAgentPlacementOpen)
  const attachIntent = useAppStore(state => state.dispatchAttachIntent)
  const linkedAgentParentId = useAppStore(state => state.linkedAgentParentId)
  const closeNewAgentPlacement = useAppStore(state => state.closeNewAgentPlacement)
  const closeDispatchAttach = useAppStore(state => state.closeDispatchAttach)
  const closeLinkedAgent = useAppStore(state => state.closeLinkedAgent)
  const close = useCallback(() => {
    closeNewAgentPlacement()
    closeDispatchAttach()
    closeLinkedAgent()
  }, [closeDispatchAttach, closeLinkedAgent, closeNewAgentPlacement])
  return {
    open: newAgentPlacementOpen || attachIntent !== null || linkedAgentParentId !== null,
    attachIntent,
    linkedAgentParentId,
    close,
  }
}
```

- [ ] **Step 2: `RestoreBanner.tsx`** — the `restoreBannerMessage` derivation (App.tsx:579-586, why-a-banner-not-a-toast comment verbatim) + the banner JSX (App.tsx:591-604), reading `useWorkspaceContext().restoreStatus`; returns `null` when no message.

- [ ] **Step 3: `SettingsBar.tsx`** — the settings-bar row (App.tsx:608-668) verbatim: `AppearanceMenu` (reads `settings`/`setSettings` from store), the perf button (`performancePanelOpen`/`togglePerformancePanel` from store), the caff button (reads `useCaffeinateStore` status/toggle, keeping the three-state title/className logic), `<PerformancePanel open={performancePanelOpen} workspace={useWorkspaceContext()} />`, and `<SystemPerfHeader />` with its self-gating comment.

- [ ] **Step 4: `WelcomeEmpty.tsx`** — moved verbatim from App.tsx:1129-1152, prop signature unchanged (`{ onNewTabRequest: () => void }`).

- [ ] **Step 5: `MainSurface.tsx`** — the mode-routing block (App.tsx:678-769) verbatim, including the entire focus-takeover-vs-shell comment (App.tsx:680-712) — that comment is the design record for why Reader/Spotlight/Settings bypass `GlobalEditorShell`. Sources: `workspace` from context; `settings`/`setSettings`/`resetSettings`/`settingsPageOpen`/`closeSettingsPage` from store; placement overlay from `usePlacementOverlay()`; takes `onNewTabRequest` as its one prop (threaded to `WelcomeEmpty`). Component skeleton:

```tsx
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspaceContext } from '@renderer/workspace/WorkspaceContext'
import { SettingsPage } from '@renderer/features/settings/ui/SettingsPage'
import { ReaderView } from '@renderer/features/reader/ui/ReaderView'
import { SpotlightView } from '@renderer/features/spotlight/ui/SpotlightView'
import { GlobalEditorShell } from '@renderer/features/global-editor/ui/GlobalEditorShell'
import { TileTabsView } from '@renderer/features/tile-tabs/ui/TileTabsView'
import { DispatchLayout } from '@renderer/workspace/dispatch/DispatchLayout'
import { TileTree } from '@renderer/workspace/tile-tree/TileTree'
import { NewAgentPlacementOverlay } from '@renderer/features/workspace/ui/NewAgentPlacementOverlay'
import { usePlacementOverlay } from '@renderer/features/workspace/surfaces/usePlacementOverlay'
import { WelcomeEmpty } from './WelcomeEmpty'

export function MainSurface({ onNewTabRequest }: { onNewTabRequest: () => void }) {
  const workspace = useWorkspaceContext()
  const settings = useAppStore(state => state.settings)
  const setSettings = useAppStore(state => state.setSettings)
  const resetSettings = useAppStore(state => state.resetSettings)
  const settingsPageOpen = useAppStore(state => state.settingsPageOpen)
  const closeSettingsPage = useAppStore(state => state.closeSettingsPage)
  const placement = usePlacementOverlay()
  const { activeTab, state } = workspace
  // <MOVE the readerModeTabExists / spotlightTabExists guards
  //  (App.tsx:483-490) here verbatim, then the entire mode-routing JSX
  //  (App.tsx:713-768) with placement.open / placement.attachIntent /
  //  placement.linkedAgentParentId / placement.close substituted for
  //  the old locals.>
}
```

- [ ] **Step 6: `shell/index.ts`** barrel:

```ts
// Barrel for the composition root. SetupGate is re-exported here so
// App.tsx itself has ZERO `@renderer/features/*` imports — the #494
// acceptance criterion is "no direct feature-surface imports in App";
// shell files are the designated place where feature composition
// happens.
export { RestoreBanner } from './RestoreBanner'
export { SettingsBar } from './SettingsBar'
export { MainSurface } from './MainSurface'
export { SetupGate } from '@renderer/features/setup/ui/SetupGate'
```

- [ ] **Step 7: Final App.tsx** — complete target file (~110 lines with comments):

```tsx
import { useAppStore } from '@renderer/app-state/hooks'
import { useWorkspace } from '@renderer/workspace/workspaceStore'
import { WorkspaceProvider } from '@renderer/workspace/WorkspaceContext'
import { useKeybinds } from '@renderer/workspace/tile-tree/useKeybinds'
import { TabBar } from '@renderer/workspace/tile-tree/TabBar'
import { useRenderedLeaseHygiene } from '@renderer/workspace/hook/effects/useRenderedLeaseHygiene'
import { useThemeSync } from '@renderer/features/settings/hooks/useThemeSync'
import { useAiWorkspaceOpenRequests } from '@renderer/features/global-editor/hooks/useAiWorkspaceOpenRequests'
import { useDevDebugConfigSync } from '@renderer/features/debug/devDebugConfig'
import { useDebugAutosave } from '@renderer/features/debug/useDebugAutosave'
import { useCaffeinateSync } from '@renderer/features/caffeinate/useCaffeinateSync'
import { useDictationHotkeySync } from '@renderer/features/voice-dictation/useDictationHotkeySync'
import { usePathPickerRequests } from '@renderer/features/path-picker/usePathPickerRequests'
import { GlobalModals } from '@renderer/app/surfaces/GlobalModals'
import { GlobalOverlays } from '@renderer/app/surfaces/GlobalOverlays'
import { SidePanels } from '@renderer/app/surfaces/SidePanels'
import { MainSurface, RestoreBanner, SettingsBar, SetupGate } from '@renderer/app/shell'

// App — the composition root, and ONLY that (issue #494).
//
// Responsibilities:
//   1. Cross-cutting sync hooks (theme, dev-debug, caffeinate,
//      dictation, ai-workspace doorbell) — each owned by its feature,
//      mounted exactly once here.
//   2. Instantiate the workspace hook (owns all tab/pane state + IPC)
//      and provide it via WorkspaceContext.
//   3. Register global keybinds.
//   4. Render the layout shell: banner → tab bar → settings bar →
//      main surface + side panels → overlays → modals.
//
// Every modal/overlay/panel mounts via app/surfaces/registry.tsx.
// ADDING A SURFACE MUST NOT EDIT THIS FILE — write a wrapper in the
// owning feature's surfaces/ folder and register it. If you find
// yourself adding a useEffect here, it belongs in a feature hook.
export default function App() {
  const dangerousAgentsEnabled = useAppStore(state => state.settings.dangerousAgentsEnabled)
  const useProxyStreaming = useAppStore(state => state.settings.useProxyStreaming)
  const defaultWorkspaceMode = useAppStore(state => state.settings.defaultWorkspaceMode)
  const toggleCommandPalette = useAppStore(state => state.toggleCommandPalette)

  useThemeSync()
  useAiWorkspaceOpenRequests()
  useDevDebugConfigSync()
  useCaffeinateSync()
  useDictationHotkeySync()

  const workspace = useWorkspace(dangerousAgentsEnabled, useProxyStreaming, defaultWorkspaceMode)
  useRenderedLeaseHygiene(workspace)
  useDebugAutosave(workspace)

  const { onNewTabRequest, onResumeRequest } = usePathPickerRequests()
  useKeybinds(workspace, onNewTabRequest, onResumeRequest, toggleCommandPalette)

  return (
    <WorkspaceProvider workspace={workspace}>
      <div className="relative h-screen flex flex-col bg-canvas text-ink font-code min-h-0">
        <SetupGate />
        <RestoreBanner />
        <TabBar workspace={workspace} onNewTabRequest={onNewTabRequest} />
        <SettingsBar />
        <div className="flex-1 min-h-0 min-w-0 flex overflow-hidden">
          <main className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <MainSurface onNewTabRequest={onNewTabRequest} />
          </main>
          <SidePanels />
        </div>
        <GlobalOverlays />
        <GlobalModals />
      </div>
    </WorkspaceProvider>
  )
}
```
Note the `<main>` wrapper stays in App (it is the layout skeleton), while everything inside it moved to `MainSurface`.

- [ ] **Step 8: Grep gates** (the audit's "prove the move" discipline — run and paste outputs into the PR description):

```bash
wc -l src/renderer/src/app/App.tsx                                   # expect ≲ 130
grep -n "@renderer/features" src/renderer/src/app/App.tsx            # expect: no output
grep -cn "useEffect" src/renderer/src/app/App.tsx                    # expect: 0
grep -n "useState" src/renderer/src/app/App.tsx                      # expect: no output
# No duplicated effect bodies left behind:
grep -rn "configureDictationHotkey\|autosaveActiveAgentDebugBundles\|getCaffeinateStatus\|remoteSetThemeSettings\|onAiWorkspaceOpenRequest" src/renderer/src/app/
# expect: no output (all five live in feature hooks now)
```

- [ ] **Step 9: Verify + commit**

```bash
npx tsc -b && npm run test:renderer
git add src/renderer/src/app/ src/renderer/src/features/workspace/surfaces/usePlacementOverlay.ts
git commit -m "refactor(app-shell): App.tsx to thin composition root (#494)"
```

---

### Task 13: Full verification + manual pass + PR

- [ ] **Step 1: Full gates**

```bash
npx tsc -b          # both projects (node + web) — MUST be clean
npm run test        # full suite (unit + integration + renderer)
```

- [ ] **Step 2: Manual pass** — launch the app (`npm run dev`) and open EVERY surface once; each row must open, function, and close. This is the issue's explicit acceptance step and the only guard for the DOM-order/stacking notes in Design Decision 7:

| Surface | How to open |
|---|---|
| Command palette | ⌘⇧P |
| Path picker (new tab) | ⌘T / tab-bar "+" / welcome button |
| Path picker (resume) | resume command from palette |
| Tile tabs modal | "Tile Tabs" palette command |
| Reorder tabs | "Reorder Tabs" palette command |
| Pin agents | "Pin Agents" palette command (verify pinned-first ordering) |
| Bury pane prompt | bury command on a focused pane |
| Debug bundle note | save-debug-bundle flow |
| Recording note | Attach-Recording-Note (needs dev-debug + recording enabled) |
| View prompts | "View Prompts" palette command |
| Prompt search | "Search Prompts" palette command |
| Agent activity | "Agent Activity" palette command |
| Close old agents | palette command |
| Bulk provider switch | palette command |
| Agent view-mode picker | palette command on a session |
| Rewind to prompt | palette command |
| Usage modal | palette command / composer keybind |
| Tiled-dispatch count overlay | tiled-dispatch palette command |
| Voice dictation overlay | dictation hotkey (if configured) |
| Caffeinate toast | click "caff" button — verify toast appears + auto-dismisses in 5s |
| Git bar / Worktrees bar | palette toggles |
| Agent status panel | palette toggle (needs a target session) |
| Remote panel | palette toggle |
| 4 debug panels | palette toggles — verify they open WITHOUT dev-debug config |
| Dev debug panel | palette toggle WITH dev-debug config on |
| Settings / Reader / Spotlight / Global editor | palette + keybinds (⌘⇧E) — verify editor state survives mode flips |
| New-agent placement overlay | split/attach/linked-agent commands — verify Esc closes and no stale intent leaks between the three flows |
| Restore banner | (only verifiable by breaking workspace.json — skip unless already testing restore) |
| Theme | flip theme in AppearanceMenu — desktop updates AND remote pages match |
| Keybinds | spot-check ⌘T, ⌘1..9, ⌥h/j/k/l, two-digit dispatch chords |

- [ ] **Step 3: Push + PR** (do NOT merge — user policy):

```bash
git push -u origin refactor/app-shell-composition-root
gh pr create --title "refactor: App.tsx god render-root → thin composition root + surface registry (#494)" --body "<summary + grep-gate outputs + manual-pass checklist + Design Decisions 2/3/7 called out as reviewer attention points + note on #493 coexistence>"
```

---

## Self-Review Notes (done at plan-writing time)

1. **Spec coverage vs issue #494:** surface registry (Tasks 1, 5–10) ✔; effects → feature hooks (Tasks 3–5, 11) ✔; thin composition root ≤150 lines (Task 12) ✔; zero-App-edit surface addition (Design Decision 1 + registry) ✔; debug surfaces out of prod tree (Task 9, via lazy — Design Decision 3 documents the deliberate deviation from a hard dev-debug gate) ✔; no behavior change (verbatim moves + Task 13 manual pass) ✔.
2. **`<MOVE …VERBATIM>` markers** (PathPickerSurface, PinAgentsSurface, useDebugAutosave, useRenderedLeaseHygiene, RestoreBanner, SettingsBar, MainSurface, WelcomeEmpty): these are relocation instructions pointing at exact existing App.tsx line ranges, not TODOs — the code already exists and duplicating it in this document would create a second source of truth that drifts from the file being edited.
3. **Type consistency:** `SurfaceEntry` (Task 1) is what every registration in Tasks 3–10 satisfies; `usePathPickerRequests` return shape (Task 5) matches its uses in Tasks 10 and 12; Task 2's `openAgentViewModePicker(sessionId)` matches Task 6's surface and Task 10's palette assembly; `useDebugAutosave(workspace: Workspace)` / `useRenderedLeaseHygiene(workspace: Workspace)` match the Task 12 call sites.
4. **Known intentional reorderings:** three fixed-position siblings change DOM order (Design Decision 7); palette moves from after VoiceDictationOverlay to first modal-group entry — all `fixed` layers with explicit z-index, covered by the manual pass.
5. **Rebase risk vs #493:** file-level overlap is empty except App.tsx import lines (`AppearanceMenu` moving into `SettingsBar.tsx`). Whichever branch lands second re-runs `npx tsc -b` and fixes at most import paths.
