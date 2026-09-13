# Extension Platform — Stage 1 Implementation Plan

> **Status: SUPERSEDED (2026-07-20) by `2026-07-20-extension-platform.md`.**
>
> This plan was executed. It produced a working host plus a compiled-in Timer app,
> and the Timer was then deleted: a compiled-in app is app source code behind an API
> boundary, not an extension. It cannot be installed and it ships in the bundle.
>
> Two claims in this document were later shown to be wrong and must not be reused:
> that Stage 2 is "a registry swap plus a five-line commandDefs change" (an
> adversarial audit enumerated eight more host changes), and that React would be
> "injected through the host object" (the ABI has no react field; the successor plan
> resolves this with a namespaced global and a DOM-level view contract).
>
> Kept for the reasoning in §0-§3, which the successor builds on.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working in-app Timer, mounted through a real extension host API (`AgentCodeApiV1`), so that Stage 2 can move the Timer out of this repo without changing one line inside it.

**Architecture:** Apps are compiled into the renderer and registered in one static array — the same contract `app/surfaces/registry.tsx` and `features/command-palette/registry.ts` already use. The load-bearing discipline is that an app receives **exactly one prop, `api: AgentCodeApiV1`, and imports nothing from `@renderer/*`**. That prop is the transport boundary: today it is a direct function table, and in Stage 2 it becomes a `postMessage` RPC facade with no change on the app side. Per-app state is main-owned under `STATE_DIR`, never the zustand-persist `Settings` store.

**Tech Stack:** TypeScript, React 18, Zustand, Radix Dialog, Electron IPC, Vitest (existing suite only — see Global Constraints).

**Prior art this plan is derived from:**
- `docs/superpowers/specs/2026-07-20-extension-platform-investigation.md` (evidence, committed on this branch)
- Four consultants under orchestration run `extension-platform-consult`. Both Claude consultants — assigned opposing briefs — independently converged on "compiled-in first, but built as Stage 2's substrate." The Codex API consultant supplied the tiering model; the Codex frame-boundary consultant priced Stage 2's alternative at ~350–650 LOC of bridge and is why Stage 2 is *conditional*, not scheduled.

---

## Global Constraints

- **No new committed test files.** Per standing repo feedback, feature PRs do not add test files or wire new `test:*` scripts. Verification in this plan is `npm run typecheck` plus explicit manual smoke steps. Where a test *would* go, the plan says so in a `TEST-SITE:` note so a later cleanup PR can pick it up. **If this constraint is lifted, convert every `TEST-SITE:` note into a real `*.renderer.test.tsx` before starting the task it belongs to.**
- **Every host API call returns a `Promise`.** No exceptions, including ones that could be synchronous today. This is the single forward-compatibility constraint that keeps Stage 2 a swap instead of a rewrite — `postMessage` cannot be made synchronous later. Costs nothing now.
- **An app imports nothing from `@renderer/*`.** Not the store, not `components/ui`, not `lib/utils`. If an app needs something, it comes through `api`. This is binary and checkable by grep.
- **Extension state never touches the zustand-persist `Settings` store.** `app-state/store.ts:35-57` records that a forgotten version bump black-screened launch twice (#249). Extension data must not be able to do that.
- **`AppDefinition` stays serializable-plus-one.** Every field except `Component` must be expressible in a JSON manifest. Adding a host-only field (e.g. `getWorkspace: () => Workspace`) converts this from a manifest target into a host interface and is exactly the tear-out this staging exists to avoid.
- **Node 24** (`.nvmrc`), **Electron 43.1.1** (lockfile). The local `node_modules` in this worktree may be stale at 31.7.7 — see Task 0.
- New surface registry entries go at the **END** of their array unless a stacking reason is written down (`app/surfaces/registry.tsx:33-38`; PR #505 shipped a regression by ignoring this).

---

## File Structure

**New — main process**

| File | Responsibility |
|---|---|
| `src/main/extensions/storage.ts` | Read/write one JSON blob per app id under `STATE_DIR/extensions/<id>/state.json`, atomically. Id validation lives here. |
| `src/main/ipc/extensions.ts` | Four `ipcMain.handle` registrations wrapping the above. |

**New — preload**

| File | Responsibility |
|---|---|
| `src/preload/api/extensions.ts` | `extensionStorage*` invoke wrappers. |

**New — renderer**

| File | Responsibility |
|---|---|
| `src/renderer/src/apps/api/types.ts` | `AgentCodeApiV1` — the ABI. The most permanent artifact in this plan. |
| `src/renderer/src/apps/api/useAppHostApi.ts` | Builds a per-app `AgentCodeApiV1` instance. |
| `src/renderer/src/apps/types.ts` | `AppDefinition`. |
| `src/renderer/src/apps/registry.ts` | `APPS` array + `APP_BY_ID`. One import + one entry per app. |
| `src/renderer/src/apps/surfaces/AppHostSurface.tsx` | The single surface entry. Resolves `openAppId`, renders the app in a `DialogContent`. |
| `src/renderer/src/apps/commands/appCommands.ts` | `CommandDef[]` derived by mapping `APPS`. |
| `src/renderer/src/apps/timer/index.ts` | The Timer's `AppDefinition`. |
| `src/renderer/src/apps/timer/ui/TimerApp.tsx` | The Timer UI. Imports only `react` and `../../api/types`. |

**Modified**

| File | Change |
|---|---|
| `src/main/storage/paths.ts` | `+ EXTENSION_STATE_DIR` |
| `src/main/ipc/index.ts` | `+ import`, `+ registerExtensionsIpc()` |
| `src/preload/api/index.ts` | `+ import`, `+ ...extensionsApi` |
| `src/renderer/src/app-state/uiShell/types.ts` | `+ openAppId`, `+ openApp`, `+ closeApp` |
| `src/renderer/src/app-state/uiShell/slice.ts` | initial value + two actions |
| `src/renderer/src/app/surfaces/registry.tsx` | `+ import`, `+ { id: 'app-host', … }` at END of `modalSurfaces` |
| `src/renderer/src/features/command-palette/types.ts` | `+ openApp` on `CommandContext.ui` |
| `src/renderer/src/features/command-palette/registry.ts` | `+ import`, `+ ...appCommands` |
| `src/renderer/src/components/ui/README.md` | Paragraph recording why `AppHostSurface` is not a "surface factory" |

---

## Task 0: Restore the toolchain

**Files:** none — environment only.

**Interfaces:**
- Consumes: nothing.
- Produces: a `node_modules` matching the lockfile. Every later task's `npm run typecheck` depends on this.

- [ ] **Step 1: Check what is actually installed**

```bash
cd /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/extension-platform
node -p "require('electron/package.json').version"
```

Expected if stale: `31.7.7`. Expected if healthy: `43.1.1`. **If it already prints `43.1.1`, skip to Step 4.**

- [ ] **Step 2: Reinstall from the lockfile**

`node_modules` is shared by ~30 worktrees via symlink, so this is a global change. Confirm no dev server or build is running anywhere first.

```bash
cd /Users/juliusolsson/Desktop/Development/agent-code
nvm use          # .nvmrc = 24
unset NODE_ENV   # NODE_ENV=production strips ALL devDeps, including electron
npm ci --include=dev
```

Expected: completes, and `postinstall` runs `electron-rebuild -f -w node-pty`.

- [ ] **Step 3: Verify**

```bash
node -p "require('electron/package.json').version"   # → 43.1.1
```

- [ ] **Step 4: Baseline the worktree**

```bash
cd /Users/juliusolsson/Desktop/Development/agent-code/.worktrees/extension-platform
npm run typecheck
```

Expected: PASS. If it fails, fix that **before** writing any code — a pre-existing failure will be misattributed to this work. Note: `hotkeyBinding.test.ts` is a known pre-existing failure in fresh worktrees and is not caused by this plan.

- [ ] **Step 5: No commit** — nothing changed in the repo.

---

## Task 1: Per-app storage (main + IPC + preload)

**Files:**
- Create: `src/main/extensions/storage.ts`
- Create: `src/main/ipc/extensions.ts`
- Create: `src/preload/api/extensions.ts`
- Modify: `src/main/storage/paths.ts`
- Modify: `src/main/ipc/index.ts`
- Modify: `src/preload/api/index.ts`

**Interfaces:**
- Consumes: `STATE_DIR` from `@main/storage/paths.js`.
- Produces: on `window.api` —
  - `extensionStorageGet(appId: string, key: string): Promise<unknown>`
  - `extensionStorageSet(appId: string, key: string, value: unknown): Promise<void>`
  - `extensionStorageDelete(appId: string, key: string): Promise<void>`
  - `extensionStorageKeys(appId: string): Promise<string[]>`

- [ ] **Step 1: Add the state root**

In `src/main/storage/paths.ts`, after the `STATE_FILE` export:

```ts
// Per-app extension state, one directory per app id, one state.json inside.
//
// WHY main-owned and not the renderer's zustand-persist blob: app-state/store.ts:35-57
// records that adding a field without bumping the persist version black-screened launch
// twice (#249). Extension data is authored outside the app's release cycle, so it must
// not be able to reach that failure mode at all. A per-app file also means uninstalling
// an app is `rm -rf` of one directory.
export const EXTENSION_STATE_DIR = join(STATE_DIR, 'extensions')
```

- [ ] **Step 2: Write the storage module**

Create `src/main/extensions/storage.ts`:

```ts
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'

import { EXTENSION_STATE_DIR } from '@main/storage/paths.js'

// WHY ids are validated rather than sanitized: an app id becomes a directory name, so
// a permissive id is a path-traversal primitive. Sanitizing (stripping bad characters)
// silently collapses distinct ids onto the same directory — `../x` and `x` would share
// state. Rejecting is the only option where the failure is visible.
const APP_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/

export class InvalidAppIdError extends Error {}

function stateFileFor(appId: string): string {
  if (!APP_ID_PATTERN.test(appId)) {
    throw new InvalidAppIdError(
      `invalid app id ${JSON.stringify(appId)} — must match ${APP_ID_PATTERN}`,
    )
  }
  return join(EXTENSION_STATE_DIR, appId, 'state.json')
}

async function readAll(appId: string): Promise<Record<string, unknown>> {
  const file = stateFileFor(appId)
  try {
    const raw = await readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    // A corrupt or non-object file degrades to empty rather than throwing. An app
    // losing its saved state is recoverable; an app that cannot start is not.
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

async function writeAll(appId: string, data: Record<string, unknown>): Promise<void> {
  const file = stateFileFor(appId)
  await mkdir(join(EXTENSION_STATE_DIR, appId), { recursive: true })
  // temp+rename, matching workspace.json's discipline: a crash mid-write must not be
  // able to leave a half-written JSON file that then fails to parse forever.
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await rename(tmp, file)
}

export async function extensionStorageGet(appId: string, key: string): Promise<unknown> {
  return (await readAll(appId))[key]
}

export async function extensionStorageSet(
  appId: string,
  key: string,
  value: unknown,
): Promise<void> {
  const data = await readAll(appId)
  data[key] = value
  await writeAll(appId, data)
}

export async function extensionStorageDelete(appId: string, key: string): Promise<void> {
  const data = await readAll(appId)
  delete data[key]
  await writeAll(appId, data)
}

export async function extensionStorageKeys(appId: string): Promise<string[]> {
  return Object.keys(await readAll(appId))
}
```

`TEST-SITE:` `src/main/extensions/storage.test.ts` — id rejection (`../evil`, `''`, `A`), round-trip, corrupt-file-degrades-to-empty.

- [ ] **Step 3: Write the IPC module**

Create `src/main/ipc/extensions.ts`:

```ts
import { ipcMain } from 'electron'

import {
  extensionStorageDelete,
  extensionStorageGet,
  extensionStorageKeys,
  extensionStorageSet,
} from '@main/extensions/storage.js'

// WHY appId is a parameter rather than derived from the sender: in Stage 1 every app
// shares the one renderer WebContents, so the sender cannot distinguish them. This is
// therefore NOT an authority boundary yet — it is a namespace. Stage 2, where each app
// gets its own frame/preload, is where appId becomes sender-derived and enforceable.
// Do not add any capability beyond storage here until that binding exists.
export function registerExtensionsIpc(): void {
  ipcMain.handle('extensions:storage-get', (_e, appId: string, key: string) =>
    extensionStorageGet(appId, key),
  )
  ipcMain.handle('extensions:storage-set', (_e, appId: string, key: string, value: unknown) =>
    extensionStorageSet(appId, key, value),
  )
  ipcMain.handle('extensions:storage-delete', (_e, appId: string, key: string) =>
    extensionStorageDelete(appId, key),
  )
  ipcMain.handle('extensions:storage-keys', (_e, appId: string) => extensionStorageKeys(appId))
}
```

- [ ] **Step 4: Register it**

In `src/main/ipc/index.ts`, add the import alongside the others:

```ts
import { registerExtensionsIpc } from '@main/ipc/extensions.js'
```

and the call at the end of `registerAllIpc`, after `registerWorkflowIpc(deps.workflowBridge)`:

```ts
  registerExtensionsIpc()
```

- [ ] **Step 5: Write the preload domain**

Create `src/preload/api/extensions.ts`:

```ts
import { ipcRenderer } from 'electron'

export const extensionsApi = {
  extensionStorageGet: (appId: string, key: string): Promise<unknown> =>
    ipcRenderer.invoke('extensions:storage-get', appId, key),
  extensionStorageSet: (appId: string, key: string, value: unknown): Promise<void> =>
    ipcRenderer.invoke('extensions:storage-set', appId, key, value),
  extensionStorageDelete: (appId: string, key: string): Promise<void> =>
    ipcRenderer.invoke('extensions:storage-delete', appId, key),
  extensionStorageKeys: (appId: string): Promise<string[]> =>
    ipcRenderer.invoke('extensions:storage-keys', appId),
}
```

In `src/preload/api/index.ts` add the import and spread it last:

```ts
import { extensionsApi } from '@preload/api/extensions.js'
// …
  ...workflowsApi,
  ...extensionsApi,
}
```

- [ ] **Step 6: Verify**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Manual smoke**

```bash
npm run dev
```

In the renderer DevTools console:

```js
await window.api.extensionStorageSet('timer', 'presets', [5, 15, 25])
await window.api.extensionStorageGet('timer', 'presets')   // → [5, 15, 25]
await window.api.extensionStorageKeys('timer')             // → ['presets']
```

Then confirm on disk:

```bash
cat ~/.config/agent-code/extensions/timer/state.json
```

Expected: `{ "presets": [5, 15, 25] }`. Also confirm rejection:

```js
await window.api.extensionStorageGet('../evil', 'x')       // → throws InvalidAppIdError
```

- [ ] **Step 8: Commit**

```bash
git add src/main/extensions/storage.ts src/main/ipc/extensions.ts \
        src/main/storage/paths.ts src/main/ipc/index.ts \
        src/preload/api/extensions.ts src/preload/api/index.ts
git commit -m "feat(extensions): per-app main-owned storage

Namespaced JSON state per app id under STATE_DIR/extensions/<id>/, atomic
temp+rename. Ids are validated, not sanitized: an id becomes a directory
name, so a permissive id is a traversal primitive and sanitizing would
silently collapse distinct ids onto one directory.

Deliberately NOT the zustand-persist Settings store — app-state/store.ts:35-57
records that a forgotten persist version bump black-screened launch twice
(#249), and extension data is authored outside the app's release cycle.

appId is a namespace here, not authority: Stage 1 apps share one WebContents
so the sender cannot distinguish them. It becomes enforceable in Stage 2.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `AgentCodeApiV1` — the ABI

**Files:**
- Create: `src/renderer/src/apps/api/types.ts`
- Create: `src/renderer/src/apps/api/useAppHostApi.ts`

**Interfaces:**
- Consumes: `window.api.extensionStorage*` (Task 1), `useGlobalToast` from `@renderer/ui/GlobalToast`.
- Produces: `AgentCodeApiV1` type and `useAppHostApi(appId: string, onClose: () => void): AgentCodeApiV1`.

- [ ] **Step 1: Define the ABI**

Create `src/renderer/src/apps/api/types.ts`:

```ts
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue }

/**
 * The Agent Code app host API, version 1.
 *
 * WHY this exists at all in a stage where apps are compiled in and could simply
 * import `useAppStore`: this object IS the migration boundary. An app that talks
 * only through it can move out of this repo — into a runtime-loaded bundle or an
 * iframe — with zero edits. An app that reaches into `@renderer/*` cannot, and the
 * cost of discovering that is a rewrite of every app at once. The rule is binary
 * and grep-checkable, which is the only kind of architectural rule that survives.
 *
 * WHY every method returns a Promise, including ones that could be synchronous:
 * under a future postMessage transport nothing can be synchronous, and a signature
 * cannot be made async later without touching every call site in every app. This
 * costs nothing today and is the single highest-value forward-compatibility
 * decision in the design.
 *
 * WHY the surface is this small: it is Tier 0 from the API consultation —
 * everything an app can have without asking for consent. Workspace, session,
 * transcript, git, and network access are Tiers 1-3, each gated on a manifest
 * capability that does not exist yet. Adding one before a real app needs it means
 * guessing at a contract with no consumer to validate it against.
 */
export interface AgentCodeApiV1 {
  readonly extension: {
    readonly id: string
    readonly apiVersion: 1
  }

  readonly storage: {
    get<T extends JsonValue>(key: string): Promise<T | undefined>
    set(key: string, value: JsonValue): Promise<void>
    delete(key: string): Promise<void>
    keys(): Promise<string[]>
  }

  readonly ui: {
    /** Close this app's view. */
    close(): Promise<void>
    /** Transient app-wide toast. Not an OS notification — that is Tier 3. */
    showToast(message: string): Promise<void>
  }

  readonly theme: {
    /**
     * Resolved `--theme-*` custom properties. Apps should prefer plain CSS
     * (`var(--theme-surface)`) — those cascade for free today and keep working
     * across a frame boundary once the host pushes them. This accessor exists
     * only for imperative consumers (canvas, inline SVG fills).
     */
    tokens(): Promise<Record<string, string>>
  }
}
```

- [ ] **Step 2: Build the host instance**

Create `src/renderer/src/apps/api/useAppHostApi.ts`:

```ts
import { useMemo } from 'react'

import { useGlobalToast } from '@renderer/ui/GlobalToast'

import type { AgentCodeApiV1, JsonValue } from '@renderer/apps/api/types'

/**
 * Builds the AgentCodeApiV1 instance handed to one app.
 *
 * WHY a hook and not a module-level singleton: `showToast` comes from React
 * context (ui/GlobalToast.tsx), and `close` is the host's own state action. Both
 * are per-mount. The app never sees either of those origins — it sees the ABI.
 *
 * WHY appId is closed over rather than passed per call: the app must not be able
 * to name a different app's namespace. In Stage 1 that is a convention enforced by
 * this closure; in Stage 2 it becomes enforceable because each app gets its own
 * frame and the main process derives the id from the sender instead.
 */
export function useAppHostApi(appId: string, onClose: () => void): AgentCodeApiV1 {
  const { showToast } = useGlobalToast()

  return useMemo<AgentCodeApiV1>(
    () => ({
      extension: { id: appId, apiVersion: 1 },

      storage: {
        get: async <T extends JsonValue>(key: string): Promise<T | undefined> =>
          (await window.api.extensionStorageGet(appId, key)) as T | undefined,
        set: (key: string, value: JsonValue) =>
          window.api.extensionStorageSet(appId, key, value),
        delete: (key: string) => window.api.extensionStorageDelete(appId, key),
        keys: () => window.api.extensionStorageKeys(appId),
      },

      ui: {
        close: async () => {
          onClose()
        },
        showToast: async (message: string) => {
          showToast(message)
        },
      },

      theme: {
        tokens: async () => {
          // Read from the documented token layer only (--theme-*), not the Tailwind
          // binding layer (--color-*). The former is the stable contract; the latter
          // is an implementation detail of how utilities are wired and would make an
          // app depend on the app's build system.
          const style = getComputedStyle(document.documentElement)
          const out: Record<string, string> = {}
          for (const sheet of Array.from(document.styleSheets)) {
            let rules: CSSRuleList
            try {
              rules = sheet.cssRules
            } catch {
              continue // cross-origin stylesheet (webfonts); nothing to read
            }
            for (const rule of Array.from(rules)) {
              if (!(rule instanceof CSSStyleRule)) continue
              for (const prop of Array.from(rule.style)) {
                if (prop.startsWith('--theme-')) {
                  out[prop] = style.getPropertyValue(prop).trim()
                }
              }
            }
          }
          return out
        },
      },
    }),
    [appId, onClose, showToast],
  )
}
```

- [ ] **Step 3: Verify**

```bash
npm run typecheck
```

Expected: PASS. There are no consumers yet — this task's deliverable is the contract.

`TEST-SITE:` `src/renderer/src/apps/api/useAppHostApi.renderer.test.tsx` — storage calls carry the closed-over appId; `close` invokes `onClose`.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/apps/api/
git commit -m "feat(extensions): AgentCodeApiV1, the app host ABI

The migration boundary, defined before it has consumers. An app that talks
only through this object moves out of the repo in Stage 2 unchanged; an app
that reaches into @renderer/* cannot, and finding that out later means
rewriting every app at once.

Every method returns a Promise even where it could be synchronous — a future
postMessage transport cannot be made sync, and widening a signature later
touches every call site in every app. Free now, expensive later.

Surface is Tier 0 only: storage, close, toast, theme tokens. Workspace,
session, git and network are Tiers 1-3 and stay unrepresentable until a real
app needs them and a capability model exists to gate them.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: The apps host — definition, registry, state, surface

**Files:**
- Create: `src/renderer/src/apps/types.ts`
- Create: `src/renderer/src/apps/registry.ts`
- Create: `src/renderer/src/apps/surfaces/AppHostSurface.tsx`
- Modify: `src/renderer/src/app-state/uiShell/types.ts`
- Modify: `src/renderer/src/app-state/uiShell/slice.ts`
- Modify: `src/renderer/src/app/surfaces/registry.tsx`
- Modify: `src/renderer/src/components/ui/README.md`

**Interfaces:**
- Consumes: `AgentCodeApiV1` + `useAppHostApi` (Task 2).
- Produces: `AppDefinition`, `APPS`, `APP_BY_ID`, `AppHostSurface`, and on the store: `openAppId: string | null`, `openApp(appId)`, `closeApp()`.

- [ ] **Step 1: Define `AppDefinition`**

Create `src/renderer/src/apps/types.ts`:

```ts
import type { ComponentType } from 'react'

import type { AgentCodeApiV1 } from '@renderer/apps/api/types'

/**
 * One built-in app.
 *
 * WHY every field except `Component` is JSON-expressible: this shape is
 * deliberately the target a future out-of-tree manifest resolves INTO. Keeping it
 * a strict superset-by-one of a manifest is what makes Stage 2 a swap — the loader
 * produces `Component`, everything else is read from disk. Adding a host-only
 * field here (`getWorkspace: () => Workspace`, a store selector, a React context)
 * silently converts this from a manifest target into a host-only interface, and
 * that IS the substrate-to-tear-out this staging exists to prevent.
 */
export type AppDefinition = {
  /**
   * Stable id. Becomes the command id (`app.open.<id>`), the value stored in
   * `openAppId`, and the on-disk state directory name. Renaming it orphans saved
   * state and breaks muscle memory — treat as permanent. Must satisfy the same
   * pattern main enforces: /^[a-z][a-z0-9-]{0,63}$/.
   */
  id: string
  title: string
  /**
   * REQUIRED and non-empty: this becomes the palette command's description, and
   * buildCommandRegistry throws on a blank one (features/command-palette/registry.ts).
   * A missing description is a launch crash, not a lint warning.
   */
  description: string
  keywords?: string[]
  /**
   * The app's UI.
   *
   * WHY exactly one prop, unlike SurfaceEntry.Component which takes none: for a
   * first-party surface, propless is right because it can read the store directly.
   * For an app the opposite is true — the prop IS the boundary that makes it
   * portable. `api` is the only thing an app is allowed to depend on.
   */
  Component: ComponentType<{ api: AgentCodeApiV1 }>
}
```

- [ ] **Step 2: Create the registry**

Create `src/renderer/src/apps/registry.ts`:

```ts
import type { AppDefinition } from '@renderer/apps/types'

// Adding an app = ONE import + ONE array entry, matching
// app/surfaces/registry.tsx and features/command-palette/registry.ts. An explicit
// import list is grep-able and compiler-checked; side-effect self-registration is
// neither, and makes load order load-bearing.
//
// Stage 2 note: this becomes `[...BUILTIN_APPS, ...loadedApps]`. Nothing else in
// the apps/ directory needs to change for that — which is the point.
export const APPS: AppDefinition[] = []

export const APP_BY_ID = new Map<string, AppDefinition>(APPS.map(app => [app.id, app]))
```

- [ ] **Step 3: Add the store field**

In `src/renderer/src/app-state/uiShell/types.ts`, next to `agentViewModePickerSessionId`:

```ts
  /**
   * Non-null when a built-in app is open; the value is its AppDefinition id.
   *
   * WHY one nullable id rather than one boolean per app: apps are mutually
   * exclusive by construction — a single host surface renders one at a time — and
   * N booleans would let two be true, a state the host cannot express. Same shape
   * as rewindPromptSessionId above.
   *
   * WHY uiShell (in-memory) and not persisted Settings: an app open across a
   * restart is not desirable, and more importantly extension-adjacent data must
   * never enter the zustand-persist blob (see app-state/store.ts:35-57, #249).
   */
  openAppId: string | null
```

and in the actions section of the same file, alongside `openRewindPrompt`/`closeRewindPrompt`:

```ts
  openApp: (appId: string) => void
  closeApp: () => void
```

- [ ] **Step 4: Add the slice implementation**

In `src/renderer/src/app-state/uiShell/slice.ts`, add to the initial state block next to `agentViewModePickerSessionId: null,`:

```ts
  openAppId: null,
```

and next to `openRewindPrompt` / `closeRewindPrompt`:

```ts
  openApp: appId => set({ openAppId: appId }, false, 'uiShell/openApp'),
  closeApp: () => set({ openAppId: null }, false, 'uiShell/closeApp'),
```

- [ ] **Step 5: Write the host surface**

Create `src/renderer/src/apps/surfaces/AppHostSurface.tsx`:

```tsx
import { useCallback } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import { useAppHostApi } from '@renderer/apps/api/useAppHostApi'
import { APP_BY_ID } from '@renderer/apps/registry'
import type { AppDefinition } from '@renderer/apps/types'

/**
 * The single surface entry that hosts every built-in app.
 *
 * WHY DialogContent rather than a hand-rolled shell: it mounts
 * data-agent-code-interaction-owner="app" for exactly the interval Radix traps
 * focus (components/ui/dialog.tsx:52-60). Without that marker, typing in an app's
 * input can leak Enter/paste into a background agent composer — the exact failure
 * components/ui/README.md records from the old composer guards. An app gets that
 * protection for free and cannot forget it.
 *
 * WHY the split into an inner component: useAppHostApi is a hook, so it cannot be
 * called conditionally after the `if (!app) return null` guard.
 */
export function AppHostSurface() {
  const openAppId = useAppStore(state => state.openAppId)
  const app = openAppId ? APP_BY_ID.get(openAppId) : undefined

  // An unknown id degrades to closed, deliberately unlike
  // providers/registry.renderer.ts:53 which throws on an unknown pane kind. That
  // throw is right there — a pane with no renderer is a broken workspace and must
  // be loud. It is wrong here: openAppId can hold a stale id after an app is
  // removed, and throwing inside a surface App.tsx mounts unconditionally is the
  // #249 black-screen failure mode.
  if (!app) return null

  return <OpenApp app={app} />
}

function OpenApp({ app }: { app: AppDefinition }) {
  const closeApp = useAppStore(state => state.closeApp)
  const onClose = useCallback(() => closeApp(), [closeApp])
  const api = useAppHostApi(app.id, onClose)

  return (
    <Dialog
      open
      onOpenChange={open => {
        if (!open) closeApp()
      }}
    >
      <DialogContent showCloseButton>
        <DialogTitle className="sr-only">{app.title}</DialogTitle>
        <app.Component api={api} />
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 6: Register the surface**

In `src/renderer/src/app/surfaces/registry.tsx`, add the import with the others:

```tsx
import { AppHostSurface } from '@renderer/apps/surfaces/AppHostSurface'
```

and append to the END of `modalSurfaces`, after `{ id: 'usage', … }`:

```tsx
  // Built-in apps host. Last in the modal stack, which per the paint-order rule
  // above means it paints above everything already mounted. That is correct rather
  // than incidental: an app is always user-initiated from the palette and is the
  // thing awaiting input while open, so nothing already on screen should cover it.
  { id: 'app-host', Component: AppHostSurface },
```

- [ ] **Step 7: Record the guardrail reading**

`components/ui/README.md` forbids "a generic modal schema, JSON-driven form renderer, or surface factory." Append to that section:

```markdown
### Why the apps host is not a surface factory

`apps/surfaces/AppHostSurface` renders one of N app components inside a standard
`DialogContent`. It does not generate surfaces, synthesize shells from schemas, or
introduce a second modal mechanism — it is one ordinary registry entry that
switches on `openAppId`. The guardrail targets first-party component proliferation,
where a factory hides which surfaces exist; here the surfaces are a single
compile-time array (`apps/registry.ts`) that is as greppable as the registry it
sits beside.

Worth noting for whoever revisits this: the runtime-loaded and iframe hosting
options both *would* require a genuine factory — a loader producing mount points
from manifests. This guardrail is an argument for the compiled-in staging, not
against it.
```

- [ ] **Step 8: Verify**

```bash
npm run typecheck
```

Expected: PASS.

```bash
npm run dev
```

Expected: app launches and looks **completely unchanged** — `APPS` is empty, so `AppHostSurface` always returns `null`. In DevTools:

```js
// no visible change, and no crash:
window.__ZUSTAND_DEVTOOLS__ // not required; instead confirm via the app not erroring
```

The real check is that nothing regressed: open the command palette (Cmd+Shift+P), open Settings, press Escape in each. All must behave as before.

`TEST-SITE:` `src/renderer/src/apps/surfaces/AppHostSurface.renderer.test.tsx` — unknown id renders null rather than throwing; `onOpenChange(false)` clears `openAppId`.

- [ ] **Step 9: Commit**

```bash
git add src/renderer/src/apps/ src/renderer/src/app-state/uiShell/ \
        src/renderer/src/app/surfaces/registry.tsx \
        src/renderer/src/components/ui/README.md
git commit -m "feat(extensions): apps host surface, registry and store field

One surface entry hosts every app. AppDefinition is deliberately
serializable-plus-one so it is the shape a future manifest resolves into —
the loader would produce Component and read the rest from disk.

Apps mount inside DialogContent so they inherit the interaction-ownership
marker for exactly the focus-trap interval. Without it an app's input can
leak Enter/paste into a background agent composer, which is the failure
components/ui/README.md records from the old composer guards.

Unknown openAppId degrades to closed rather than throwing — unlike the
provider pane registry, which is right to throw. A stale id here would
otherwise be a #249-class black screen inside an unconditionally mounted
surface.

Registry is empty; no user-visible change yet.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: The Timer app

**Files:**
- Create: `src/renderer/src/apps/timer/index.ts`
- Create: `src/renderer/src/apps/timer/ui/TimerApp.tsx`
- Modify: `src/renderer/src/apps/registry.ts`

**Interfaces:**
- Consumes: `AgentCodeApiV1` (Task 2), `AppDefinition` (Task 3).
- Produces: `timerApp: AppDefinition`, registered in `APPS`.

- [ ] **Step 1: Write the UI**

Create `src/renderer/src/apps/timer/ui/TimerApp.tsx`. **Note the import list — `react` and the ABI type, nothing else. That constraint is the whole point of the app.**

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'

import type { AgentCodeApiV1 } from '@renderer/apps/api/types'

const DEFAULT_PRESETS = [5, 15, 25] as const

function formatRemaining(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds)
  const minutes = Math.floor(safe / 60)
  const seconds = safe % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

export function TimerApp({ api }: { api: AgentCodeApiV1 }) {
  const [presets, setPresets] = useState<number[]>([...DEFAULT_PRESETS])
  const [remaining, setRemaining] = useState(0)
  const [running, setRunning] = useState(false)

  // Deadline-based rather than decrement-based: a setInterval that subtracts 1 each
  // tick drifts, and drifts badly when the renderer is throttled or the machine
  // sleeps. Storing the wall-clock deadline means a late tick self-corrects.
  const deadlineRef = useRef<number | null>(null)

  useEffect(() => {
    void api.storage.get<number[]>('presets').then(saved => {
      if (Array.isArray(saved) && saved.every(n => typeof n === 'number')) setPresets(saved)
    })
  }, [api])

  useEffect(() => {
    if (!running) return
    const id = setInterval(() => {
      const deadline = deadlineRef.current
      if (deadline == null) return
      const left = Math.round((deadline - Date.now()) / 1000)
      if (left <= 0) {
        setRemaining(0)
        setRunning(false)
        deadlineRef.current = null
        void api.ui.showToast('Timer finished')
        return
      }
      setRemaining(left)
    }, 250)
    return () => clearInterval(id)
  }, [running, api])

  const start = useCallback((minutes: number) => {
    deadlineRef.current = Date.now() + minutes * 60_000
    setRemaining(minutes * 60)
    setRunning(true)
  }, [])

  const stop = useCallback(() => {
    setRunning(false)
    deadlineRef.current = null
    setRemaining(0)
  }, [])

  return (
    <div className="flex flex-col items-center gap-6 px-8 py-10">
      <div
        className="font-mono tabular-nums"
        style={{
          fontSize: '64px',
          lineHeight: 1,
          color: remaining === 0 && !running ? 'var(--theme-muted)' : 'var(--theme-ink)',
        }}
      >
        {formatRemaining(remaining)}
      </div>

      <div className="flex gap-2">
        {presets.map(minutes => (
          <button
            key={minutes}
            type="button"
            onClick={() => start(minutes)}
            className="px-3 py-1.5 text-[13px] outline-none"
            style={{
              background: 'var(--theme-control-bg)',
              color: 'var(--theme-control-fg)',
              border: '1px solid var(--theme-control-border)',
            }}
          >
            {minutes}m
          </button>
        ))}
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={stop}
          disabled={!running}
          className="px-4 py-1.5 text-[13px] outline-none disabled:opacity-40"
          style={{
            background: 'var(--theme-accent)',
            color: 'var(--theme-accent-fg)',
            border: '1px solid var(--theme-accent)',
          }}
        >
          Stop
        </button>
        <button
          type="button"
          onClick={() => void api.ui.close()}
          className="px-4 py-1.5 text-[13px] outline-none"
          style={{
            background: 'transparent',
            color: 'var(--theme-ink-dim)',
            border: '1px solid var(--theme-border)',
          }}
        >
          Close
        </button>
      </div>
    </div>
  )
}
```

Note the inline `var(--theme-*)` styles rather than Tailwind utilities (`bg-surface`). Tailwind utilities are a build-time binding that will not exist once this file lives in another repo; the token names will. This is the app obeying its own portability rule.

- [ ] **Step 2: Write the definition**

Create `src/renderer/src/apps/timer/index.ts`:

```ts
import type { AppDefinition } from '@renderer/apps/types'

import { TimerApp } from '@renderer/apps/timer/ui/TimerApp'

export const timerApp: AppDefinition = {
  id: 'timer',
  title: 'Timer',
  description: 'Countdown timer with presets. Toasts when it finishes.',
  keywords: ['timer', 'countdown', 'pomodoro', 'clock', 'focus'],
  Component: TimerApp,
}
```

- [ ] **Step 3: Register it**

In `src/renderer/src/apps/registry.ts`:

```ts
import type { AppDefinition } from '@renderer/apps/types'

import { timerApp } from '@renderer/apps/timer'

export const APPS: AppDefinition[] = [timerApp]

export const APP_BY_ID = new Map<string, AppDefinition>(APPS.map(app => [app.id, app]))
```

- [ ] **Step 4: Verify the portability constraint**

```bash
grep -rn "@renderer/" src/renderer/src/apps/timer/
```

Expected: **exactly two matches**, both importing `apps/api/types` or `apps/types` — which are the ABI, not app internals. Any other `@renderer/*` import is a violation and must be removed before committing.

- [ ] **Step 5: Verify build**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Manual smoke**

```bash
npm run dev
```

In DevTools console, open it directly (the palette command lands in Task 5):

```js
// the store is not exposed globally; instead verify via Task 5.
```

Since there is no opener yet, temporarily verify by setting the initial value in `uiShell/slice.ts` to `openAppId: 'timer'`, running `npm run dev`, confirming the Timer renders, then **reverting that line**. Confirm:
- the digits use the theme ink color and switch with Cmd+Shift+ theme changes
- clicking `5m` counts down
- `Stop` resets
- `Close` dismisses the dialog
- Escape dismisses the dialog

`TEST-SITE:` `src/renderer/src/apps/timer/ui/TimerApp.renderer.test.tsx` — `formatRemaining` boundaries; deadline math does not drift under fake timers.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/apps/timer/ src/renderer/src/apps/registry.ts
git commit -m "feat(extensions): Timer app, the first AgentCodeApiV1 consumer

Imports react and the ABI type. Nothing else — verified by grep, and that
grep is the migration test: this directory should move to its own repo in
Stage 2 without a single edit inside it.

Styles use var(--theme-*) rather than Tailwind utilities on purpose. The
utilities are a build-time binding that will not exist out-of-tree; the token
names will, and the host can push them across a frame boundary.

Countdown is deadline-based, not decrement-based: a per-tick subtraction
drifts under renderer throttling and breaks outright across sleep.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Palette commands

**Files:**
- Create: `src/renderer/src/apps/commands/appCommands.ts`
- Modify: `src/renderer/src/features/command-palette/types.ts`
- Modify: `src/renderer/src/features/command-palette/registry.ts`

**Interfaces:**
- Consumes: `APPS` (Task 3/4), `CommandDef` from the palette.
- Produces: `appCommands: CommandDef[]`, and `openApp` on `CommandContext.ui`.

- [ ] **Step 1: Extend the command context type**

In `src/renderer/src/features/command-palette/types.ts`, inside the `ui: { … }` block, next to `openRewindPrompt`:

```ts
    /** Open a built-in app by AppDefinition id. The host surface resolves the
     *  id; an unknown id closes rather than throws. */
    openApp: (appId: string) => void
```

- [ ] **Step 2: Write the derived commands**

Create `src/renderer/src/apps/commands/appCommands.ts`:

```ts
import type { CommandDef } from '@renderer/features/command-palette/types'

import { APPS } from '@renderer/apps/registry'

// Derived, not hand-written: N apps produce N commands with zero per-app
// boilerplate, and an app physically cannot ship without a way to open it. This
// mapping is the whole "one command module supports N apps" claim, and it is what
// keeps adding an app to one import plus one array entry.
export const appCommands: CommandDef[] = APPS.map(app => ({
  id: `app.open.${app.id}`,
  title: `Open ${app.title}`,
  description: app.description,
  surface: 'app',
  keywords: app.keywords ?? [],
  run: ({ ui }) => {
    ui.openApp(app.id)
    ui.closePalette()
  },
}))
```

- [ ] **Step 3: Register them**

In `src/renderer/src/features/command-palette/registry.ts`, add the import and spread it after `...usageCommands`:

```ts
import { appCommands } from '@renderer/apps/commands/appCommands'
// …
  ...usageCommands,
  ...appCommands,
]
```

- [ ] **Step 4: Wire the callback**

`CommandContext.ui` is built in `src/renderer/src/features/command-palette/ui/CommandPalette.tsx`. Two edits in that file.

First, next to the other store selectors around **line 193** (`const openRewindPrompt = useAppStore(state => state.openRewindPrompt)`):

```ts
  const openApp = useAppStore(state => state.openApp)
```

Second, in the `ui: { … }` object literal that ends at **line 525** with `closePalette: onClose,` — the literal uses shorthand for every store action, so add the shorthand alongside them, immediately before `closePalette`:

```ts
        openApp,
        closePalette: onClose,
```

- [ ] **Step 5: Verify**

```bash
npm run typecheck
```

Expected: PASS. If `openApp` is missing from any object literal implementing `CommandContext['ui']`, TypeScript will name the file — that is the intended safety net.

- [ ] **Step 6: Manual smoke — the end-to-end check**

```bash
npm run dev
```

1. Cmd+Shift+P → type `timer` → **`Open Timer` appears**
2. Enter → palette closes, Timer opens
3. Click `15m` → counts down
4. Escape → closes
5. Reopen → **presets persisted** (set one via DevTools `window.api.extensionStorageSet('timer','presets',[1,2,3])` first, then reopen)
6. Let a 1-minute timer finish → **toast appears**
7. With the Timer open, press Cmd+W → **the pane closes, the window does not** (confirms the interaction-ownership marker is doing its job)

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/apps/commands/ \
        src/renderer/src/features/command-palette/types.ts \
        src/renderer/src/features/command-palette/registry.ts
git commit -m "feat(extensions): derive palette commands from the app registry

One .map over APPS, so an app cannot ship without an opener and adding an app
stays one import plus one array entry. buildCommandRegistry already recomputes
per context change, so nothing else needed touching.

Adding openApp to CommandContext.ui makes the compiler name every object
literal that implements the context — the intended safety net rather than a
runtime surprise.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Settings → Apps row

**Files:**
- Modify: `src/renderer/src/features/settings/lib/settingsRegistry.ts`
- Modify: `src/renderer/src/features/settings/lib/settingsCategories.ts:1-7`
- Create: `src/renderer/src/apps/ui/AppsSettingsRow.tsx`
- Modify: `src/renderer/src/features/settings/ui/SettingsList.tsx:220`

**Interfaces:**
- Consumes: `APPS` (Task 3/4), store `openApp`.
- Produces: an `{ type: 'apps' }` settings control.

- [ ] **Step 1: Read the marker pattern before writing anything**

```bash
sed -n '95,140p' src/renderer/src/features/settings/lib/settingsRegistry.ts
sed -n '570,600p' src/renderer/src/features/settings/lib/settingsRegistry.ts
sed -n '210,230p' src/renderer/src/features/settings/ui/SettingsList.tsx
cat src/renderer/src/features/cli-updates/CliUpdateBehaviorRow.tsx
```

Three existing markers (`cli-update-behavior`, `theme-picker`, `dictation-api-key`) have a value living outside the `Settings` store and are rendered by self-subscribing components. `CliUpdateBehaviorRow.tsx:18` documents the pattern explicitly. This task adds a fourth instance — **read all of the above before writing** and match `cli-update-behavior`, which is the closest in shape (a marker with no `getValue`/`onChange` at all).

- [ ] **Step 2: Add the control type and registry entry**

Add `'apps'` to the control-type union in `settingsRegistry.ts`, then add the entry:

```ts
  {
    id: 'apps.installed',
    category: 'apps',
    title: 'Apps',
    description: 'Built-in apps available from the command palette.',
    // Marker: the row is rendered by AppsSettingsRow, which reads the compiled-in
    // registry directly. There is no getValue/onChange because there is no setting
    // — this is a listing. Stage 3 turns it into the install/enable surface.
    control: { type: 'apps' },
  },
```

Then add `'apps'` to the `SettingCategoryId` union in `settingsCategories.ts:1-7`, which currently reads:

```ts
export type SettingCategoryId =
  | 'appearance'
  | 'workspace'
  | 'commands'
  | 'dictation'
  | 'experimental'
  | 'safety'
  | 'apps'
```

and add the matching entry to the `SettingCategory[]` array in the same file:

```ts
  {
    id: 'apps',
    label: 'Apps',
    description: 'Built-in apps available from the command palette.',
  },
```

- [ ] **Step 3: Write the row**

Create `src/renderer/src/apps/ui/AppsSettingsRow.tsx`:

```tsx
import { useAppStore } from '@renderer/app-state/hooks'
import { APPS } from '@renderer/apps/registry'

// Stage 1 is a listing, not a manager: apps are compiled in, so there is nothing
// to install, enable, or remove. Building toggles now would be UI for a state that
// cannot vary. Stage 3 replaces the body of this component and keeps its slot.
export function AppsSettingsRow() {
  const openApp = useAppStore(state => state.openApp)

  return (
    <div className="flex flex-col gap-1">
      {APPS.map(app => (
        <div key={app.id} className="flex items-center justify-between gap-4 py-1">
          <div className="min-w-0">
            <div className="text-[13px] text-ink">{app.title}</div>
            <div className="truncate text-[12px] text-muted">{app.description}</div>
          </div>
          <button
            type="button"
            onClick={() => openApp(app.id)}
            className="shrink-0 border border-control-border bg-control-bg px-3 py-1 text-[12px] text-control-fg outline-none hover:border-control-border-hover"
          >
            Open
          </button>
        </div>
      ))}
      {APPS.length === 0 ? <div className="text-[12px] text-muted">No apps installed.</div> : null}
    </div>
  )
}
```

This file is host UI, not app code, so it uses Tailwind utilities normally — the portability rule applies to `apps/<id>/`, not to `apps/ui/`.

- [ ] **Step 4: Render the marker**

In `src/renderer/src/features/settings/ui/SettingsList.tsx`, next to line 220 which reads:

```tsx
          {control.type === 'cli-update-behavior' ? <CliUpdateBehaviorRow /> : null}
```

add the sibling branch:

```tsx
          {control.type === 'apps' ? <AppsSettingsRow /> : null}
```

and the import at the top of that file:

```tsx
import { AppsSettingsRow } from '@renderer/apps/ui/AppsSettingsRow'
```

- [ ] **Step 5: Verify**

```bash
npm run typecheck
```

Expected: PASS — the control-type union is closed, so a missing branch is a compile error.

- [ ] **Step 6: Manual smoke**

`npm run dev` → open Settings → **Apps** category → Timer listed with its description → `Open` launches it → Settings' own Escape still closes Settings and not something else.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/apps/ui/ src/renderer/src/features/settings/
git commit -m "feat(extensions): Settings > Apps listing

Fourth instance of the existing self-subscribing marker pattern
(cli-update-behavior, theme-picker, dictation-api-key) — the value lives
outside the Settings store, so there is no getValue/onChange to hoist.

A listing, not a manager: apps are compiled in, so enable/remove toggles
would be UI for state that cannot vary. Stage 3 replaces this component's
body and keeps its slot.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Done — and the test that decides whether Stage 1 was honest

After Task 6, run the migration rehearsal. It costs five minutes and it is the only real check on this whole design:

```bash
grep -rn "@renderer/" src/renderer/src/apps/timer/
```

**Expected: only imports of `apps/api/types` and `apps/types`.**

If that holds, the Timer directory can be lifted into its own repository in Stage 2 and loaded through `agent-code-ext://` with **no edits inside it**. If it does not hold, Stage 1 built a substrate that Stage 2 would have to tear out — fix it now, while there is exactly one app, rather than later when there are six.

---

## Stage 2 — deliberately not planned here

Stage 2 (runtime loading via a privileged `agent-code-ext://` scheme) is **conditional, not scheduled**. Its trigger is specific: *extensions shipping to people who run packaged releases.* The owner runs `npm start` against a local build and rebuilds routinely, so Stage 1 is sufficient for personal use indefinitely.

When it is triggered, the investigation and consultation already established:

- The loader is one line — `await import(/* @vite-ignore */ \`agent-code-ext://${id}/${entry}\`)`. Monaco already performs a fully runtime-variable dynamic import in the shipped bundle (`out/renderer/assets/editor.main-*.js`), and 92 language chunks load via ESM dynamic import from `file://` in production, so both halves of the risk are empirically retired.
- React is injected through the host object; the extension's own Vite config marks `react` external. ~2 hours.
- The scheme needs `standard: true, secure: true, supportFetchAPI: true, corsEnabled: true`, registered before `app.whenReady()`, plus a realpath containment check and an explicit `access-control-allow-origin` header — module scripts are always fetched in CORS mode, and missing that header is the single most likely thing to burn a day.
- CSP becomes `script-src 'self' agent-code-ext:` (plus `connect-src` if apps fetch their own assets). `worker-src` must not be touched — the #513 comment above it is load-bearing.

**Before any of that, run a half-day spike** proving a hello-world module loads through the scheme in **both** `npm run dev` (http://localhost origin) and a packaged build (file:// origin). Dev-only success is the trap this whole design is shaped around avoiding.

The iframe option (Option C) remains available and was priced at ~350–650 LOC of bridge — keyboard routing and default suppression being the bulk, since every host shortcut dies while focus is inside a frame and Cmd+W would close the window. It becomes the right answer only when extensions come from people the owner does not trust, because it is the only option that contains an infinite loop in extension code.
