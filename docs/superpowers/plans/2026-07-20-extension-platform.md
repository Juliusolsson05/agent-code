# Extension Platform — Full Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> **Supersedes** `2026-07-20-extension-platform-stage1.md`, which planned a compiled-in
> apps folder. That was built, reviewed, and the app it produced was deleted — see
> §0. This document plans the actual product: extensions installed from a repository
> and loaded at runtime.

**Goal:** A user can paste `owner/repo` into Settings, install an extension, and run
it — with its own UI, its own persisted state, and a documented API — without that
extension living in this repository or requiring a rebuild.

**Architecture:** The VS Code model. Extensions are ES modules on disk under
`~/.config/agent-code/extensions/<id>/`, served to the renderer over a privileged
`agent-code-ext://` scheme and loaded with a runtime `import()`. A manifest declares
*contribution points* (commands, views, settings, keybindings) that reach the palette
and Settings **without the module being loaded**; the module exports
`activate(context)` / `deactivate()` and is imported lazily on a declared activation
event. Views mount at the DOM level, so React is available but optional and the
contract survives a later move into an iframe.

**Tech Stack:** Electron 43 `protocol.handle`, native ESM dynamic import, zod, React 18
(host-side only), TypeScript.

---

## Global Constraints

- **No new committed test files.** Standing repo rule. Verification is
  `npm run typecheck`, `npm test`, `npm run build`, and explicit manual smoke steps.
  `TEST-SITE:` notes mark where tests would go if the rule is lifted.
- **Every `AgentCodeApiV1` method returns a `Promise`.** No exceptions. A future
  postMessage transport cannot be made synchronous, and widening a signature later
  touches every call site in every extension.
- **The renderer's `script-src` gains exactly one source: `agent-code-ext:`.**
  Not `unsafe-eval`, not `blob:`, not `file:`. `worker-src` is not touched — the
  `#513` comment above it is load-bearing and unrelated.
- **An extension is never handed `window.api`.** It receives `AgentCodeApiV1`.
- **Extension state is never in the zustand-persist `Settings` store** (#249).
- **Bundles and state stay in separate roots.** `extensions/<id>/` is replaced
  wholesale on update; `extension-state/<id>/` must survive it.
- **Node 24, Electron 43.1.1.** Verify with `node -p "require('electron/package.json').version"`.

---

## 0. What already exists on this branch

Built, typechecked, tested, and reviewed by two agents. **Do not rebuild these.**

| Piece | Path | State |
|---|---|---|
| Host ABI | `renderer/src/apps/api/types.ts` | `AgentCodeApiV1`, Tier 0 |
| ABI instance factory | `renderer/src/apps/api/useAppHostApi.ts` | per-extension, closes over id |
| Resolved definition | `renderer/src/apps/types.ts` | `AppDefinition` |
| Registry | `renderer/src/apps/registry.ts` | `APPS` — **empty, static** |
| Host surface | `renderer/src/apps/surfaces/AppHostSurface.tsx` | Dialog + ownership marker |
| Palette commands | `renderer/src/apps/commands/appCommands.ts` | derived from `APPS` |
| Per-extension storage | `main/extensions/storage.ts` | serialized writes, unique temps |
| Manifest validation | `main/extensions/manifest.ts` | zod, `SUPPORTED_API_VERSION = 1` |
| Installer | `main/extensions/install.ts` | fetch → verify → atomic rename |
| Install ledger | `main/extensions/ledger.ts` | `extensions.json` |
| Settings UI | `renderer/src/apps/ui/AppsSettingsRow.tsx` | install / update / remove |

### Corrections to the superseded plan, recorded so they are not repeated

The Stage 1 plan claimed Stage 2 would be *"a registry swap plus a five-line
`commandDefs` change."* An adversarial audit found that **false**. The honest list is
§2 of this document. Specifically wrong were:

- `APP_BY_ID` is a module-scope snapshot; updating `APPS` alone leaves it stale.
- `appCommands` is a second module-scope snapshot, copied again into `commandDefs`,
  and read a third time by `listPickerCommandMeta()` which Settings consumes.
- `AppsSettingsRow` mapped static `APPS` (already rewritten).
- The renderer bootstrap is synchronous — there is no point at which a loader
  could await.
- The plan asserted React would be *"injected through the host object"*, but
  `AgentCodeApiV1` has no react field. §1 resolves this.

### Known defects inherited from Stage 1, to fix in Phase B

- **Toast is invisible.** `GlobalToast` is `z-50`; the dialog scrim is `z-[1100]` at
  88% opacity. `api.ui.showToast` can only fire while an extension is open, so it is
  hidden 100% of the time. Fix in Task B6.
- **`theme.tokens()` misses runtime-only tokens.** `--theme-app-font` and
  `--theme-font-code` are assigned by `theme.ts` at runtime and never appear in a
  stylesheet, so the stylesheet walk in `useAppHostApi.ts` cannot find them. Fix in
  Task B6.
- **`JsonValue` permits `NaN`/`Infinity`**, which `JSON.stringify` silently turns
  into `null`. Fix in Task B6.
- **`openApp` missing from `CommandPalette`'s `useMemo` deps.** Benign today
  (zustand actions are stable) but a stale-closure bug the moment that changes.

---

## 1. The contracts, decided

The model is **VS Code's**: a manifest declares *contribution points*, the module
exports `activate`/`deactivate`, activation is lazy and event-driven, and custom UI
is a registered view rather than a single implicit page.

An earlier draft of this plan proposed a single `mount(element, api)` export with the
host auto-generating one "Open X" command. That is a degenerate case of the model
below — one extension, one view, one command, no declarations — and it was too narrow:
it gives an extension no way to contribute more than one command, no way to add a
setting, no way to register a keybinding, and no way to do work without a window open.
Recorded here because the narrower design is the tempting one and the reasons it fails
are not obvious until you try to write a second extension.

### 1.1 The manifest declares contributions

`agent-code.extension.json` gains a `contributes` block. Everything an extension adds
to the app is **declared statically**, not discovered by running it.

```jsonc
{
  "id": "timer",
  "name": "Timer",
  "description": "Countdown timer with presets.",
  "version": "1.0.0",
  "apiVersion": 1,
  "entry": "dist/index.js",

  "activationEvents": ["onCommand:timer.start", "onView:timer.panel"],

  "contributes": {
    "commands": [
      { "id": "timer.start",  "title": "Start Timer",  "keywords": ["pomodoro"] },
      { "id": "timer.cancel", "title": "Cancel Timer" }
    ],
    "views": [
      { "id": "timer.panel", "title": "Timer", "mount": "modal" }
    ],
    "settings": [
      { "id": "timer.defaultMinutes", "title": "Default duration",
        "type": "number", "default": 25 }
    ],
    "keybindings": [
      { "command": "timer.start", "key": "cmd+shift+t" }
    ]
  }
}
```

**WHY declarations rather than registration-by-execution:** the palette, Settings, and
the keybinding router must know what exists *before* the extension has run — otherwise
every extension has to be loaded at startup just to populate a command list, and lazy
activation becomes impossible. This is the same reason VS Code puts `contributes` in
`package.json` rather than making everything an `activate()` side effect. It also
means a broken extension still shows its commands, greyed out with a reason, instead
of silently vanishing.

**WHY `mount` is an enum (`modal` | `panel` | `tab`) rather than free-form:** the host
owns where things go. An extension declares the *kind* of surface it wants and the
host decides the chrome, which is what keeps every extension feeling native and is why
the interaction-ownership and paint-order contracts hold. v1 implements `modal`;
`panel` and `tab` are the same registration with a different host shell.

### 1.2 The module contract is `activate` / `deactivate`

```ts
export function activate(context: ExtensionContext): void | Promise<void>
export function deactivate?(): void | Promise<void>

type ExtensionContext = {
  readonly api: AgentCodeApiV1
  /** Register the handler for a command declared in `contributes.commands`. */
  registerCommand(id: string, run: () => void | Promise<void>): Disposable
  /** Register the renderer for a view declared in `contributes.views`. */
  registerView(id: string, mount: ViewMount): Disposable
  /** Anything pushed here is disposed on deactivate. */
  readonly subscriptions: Disposable[]
}

type ViewMount = (element: HTMLElement) => void | (() => void)
type Disposable = { dispose(): void }
```

**WHY `activate(context)` and not `mount(element, api)`:**

1. **An extension is not always a window.** A watcher that reacts to an agent going
   idle has no UI at all. `mount` cannot express it.
2. **One extension, many contributions.** `mount` gives exactly one view and one
   command. Real extensions have several of each.
3. **`subscriptions` is the lifecycle primitive that scales.** Every registration
   returns a `Disposable`; `deactivate` disposes the array. This is the single
   mechanism that handles commands, views, event listeners and timers uniformly.
4. **It is the shape extension authors already know.** VS Code, and every system
   modelled on it. Being unfamiliar buys nothing here.

**WHY the view mount is still DOM-level** (`(element) => cleanup`) rather than a React
component: it keeps React optional (plain DOM, Preact, Svelte, canvas all work), and
it survives the iframe transport unchanged — a React component reference cannot cross
a frame boundary, but "call mount with this element" can be reimplemented on the far
side. A React author writes `createRoot(element).render(<App/>)` in one line.

### 1.3 Activation is lazy

`activationEvents` decides when the module is imported:

| Event | Fires when |
|---|---|
| `onCommand:<id>` | a declared command is invoked |
| `onView:<id>` | a declared view is opened |
| `onStartupFinished` | after the window is interactive |
| `*` | immediately at startup — discouraged, and the Settings row says so |

**WHY lazy:** the alternative is importing every installed extension's module at
startup. Ten extensions become ten third-party module evaluations before the app is
usable, and one slow or broken one degrades launch for everything. Declared
contributions are exactly what makes deferral possible — the palette can list a
command whose module has never been loaded, and importing happens on first use.

`AppDefinition.Component` stays as it is internally. The host wraps a registered
`ViewMount` in a React component (Task B4), so `AppHostSurface`, the command registry
and the storage machinery are unchanged by extensions being loaded rather than
compiled in.

### 1.2 React is provided, not injected through the API

Before loading any extension, the host publishes:

```ts
globalThis.__agentCodeHost = Object.freeze({
  react: React,
  reactDom: ReactDOM,        // createRoot
  jsxRuntime: ReactJsxRuntime,
  apiVersion: 1,
})
```

An extension that wants React marks `react`, `react-dom` and `react/jsx-runtime`
**external** in its own build, and ships a five-line shim that re-exports from that
global. The SDK template (Phase C) provides both, so an author copies rather than
derives.

**WHY a namespaced global rather than an import map:** an import map must be declared
before the first module in the document loads, and would have to resolve `react` to a
URL. The host's React lives inside a content-hashed chunk with no stable URL, so the
map would have to point at a shim that reads a global anyway — the same mechanism
with an extra indirection and a load-order constraint. **WHY frozen:** the object is
reachable from any renderer code, so freezing removes the trivial footgun of an
extension replacing the host's React for everyone.

**WHY this is not a security boundary:** a same-realm extension can already reach
`window.api` directly. The boundary in this phase is convention, and the plan says so
rather than implying otherwise. Real isolation requires the iframe transport
(Phase D), and the DOM-level mount contract is what keeps that door open.

---

## 2. Phase B — the loader

Six tasks. At the end, an installed extension runs.

### Task B1: The privileged scheme

**Files:**
- Create: `src/main/extensions/scheme.ts`
- Modify: `src/main/index.ts`
- Modify: `src/renderer/index.html`

**Interfaces:**
- Consumes: `EXTENSIONS_DIR` from `@main/storage/paths.js`.
- Produces: `registerExtensionScheme()` (module scope, pre-ready) and
  `handleExtensionScheme()` (post-ready). URLs of the form
  `agent-code-ext://<id>/<path>`.

- [ ] **Step 1: Write the scheme module**

```ts
// src/main/extensions/scheme.ts
import { net, protocol } from 'electron'
import { realpath } from 'fs/promises'
import { join, resolve as resolvePath, sep } from 'path'
import { pathToFileURL } from 'url'

import { EXTENSIONS_DIR } from '@main/storage/paths.js'

export const EXTENSION_SCHEME = 'agent-code-ext'

// WHY these exact privileges:
//   standard        — gives the scheme real origin semantics so a relative
//                     specifier inside a bundle (`./util.js` next to `index.js`)
//                     resolves. Without it every import must be absolute.
//   secure          — module scripts and most web APIs require a secure context.
//   supportFetchAPI — lets an extension fetch its own assets (JSON, CSS).
//   corsEnabled     — module scripts are ALWAYS fetched in CORS mode, and
//                     `standard` makes this a distinct origin from the document.
//
// MUST run at module scope, before app.whenReady(). Electron silently treats the
// scheme as opaque if registration happens after ready, and the failure looks like
// a CSP problem rather than an ordering one.
export function registerExtensionScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: EXTENSION_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ])
}

export function handleExtensionScheme(): void {
  protocol.handle(EXTENSION_SCHEME, async request => {
    const url = new URL(request.url)
    const extensionId = url.hostname
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '')

    // The id in the URL is a NAME, not authority — the same invariant
    // EditorFsRootRegistry enforces for filesystem roots. Resolve it against the
    // install root and then prove the realpath is still inside.
    const root = join(EXTENSIONS_DIR, extensionId)
    let rootReal: string
    try {
      rootReal = await realpath(root)
    } catch {
      return new Response('not found', { status: 404 })
    }

    let targetReal: string
    try {
      targetReal = await realpath(resolvePath(rootReal, relative))
    } catch {
      return new Response('not found', { status: 404 })
    }

    // Containment. Without this, `..%2f..%2f.ssh/id_rsa` reads arbitrary files
    // through a scheme the renderer is permitted to load SCRIPTS from — the worst
    // possible combination. Install-time validation already checks the manifest's
    // entry, but this handler serves arbitrary paths, so it needs its own check.
    if (targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) {
      return new Response('forbidden', { status: 403 })
    }

    const response = await net.fetch(pathToFileURL(targetReal).toString())
    return new Response(response.body, {
      headers: {
        'content-type': contentTypeFor(targetReal),
        // Required. Module scripts are fetched in CORS mode and this is a distinct
        // origin from the document; without this header the import() fails with an
        // opaque CORS error that looks nothing like the actual cause.
        'access-control-allow-origin': '*',
      },
    })
  })
}

function contentTypeFor(path: string): string {
  if (/\.m?js$/.test(path)) return 'text/javascript'
  if (path.endsWith('.json')) return 'application/json'
  if (path.endsWith('.css')) return 'text/css'
  if (path.endsWith('.svg')) return 'image/svg+xml'
  if (path.endsWith('.png')) return 'image/png'
  if (path.endsWith('.woff2')) return 'font/woff2'
  return 'application/octet-stream'
}
```

- [ ] **Step 2: Wire it into main**

In `src/main/index.ts`, at module scope (before any `app.whenReady()`):

```ts
import { handleExtensionScheme, registerExtensionScheme } from '@main/extensions/scheme.js'

registerExtensionScheme()
```

and inside the ready handler, before the window is created:

```ts
  handleExtensionScheme()
```

- [ ] **Step 3: Amend the CSP**

`src/renderer/index.html` — change exactly one directive:

```
script-src 'self' agent-code-ext:;
```

and add, because `default-src 'self'` currently backstops it and an extension
fetching its own JSON would otherwise fail:

```
connect-src 'self' agent-code-ext:;
```

Leave `worker-src` alone.

- [ ] **Step 4: Verify — dev**

```bash
npm run dev
```

DevTools console:

```js
const r = await fetch('agent-code-ext://nonexistent/index.js')
r.status   // → 404, NOT a CSP violation or a scheme error
```

A `net::ERR_UNKNOWN_URL_SCHEME` here means Step 2 ran after ready.

- [ ] **Step 5: Verify — packaged. This is the step that catches the real trap.**

```bash
npm run build && npm start
```

Repeat the same console check. Dev serves from `http://localhost`, production from
`file://` — a scheme that works in one and not the other is the specific failure this
whole design is shaped to avoid. **Do not proceed to B2 until both pass.**

- [ ] **Step 6: Commit**

```bash
git add src/main/extensions/scheme.ts src/main/index.ts src/renderer/index.html
git commit -m "feat(extensions): privileged agent-code-ext:// scheme"
```

---

### Task B2: Host globals

**Files:**
- Create: `src/renderer/src/apps/api/hostGlobal.ts`
- Modify: `src/renderer/src/app/main.tsx`

- [ ] **Step 1: Publish the globals**

```ts
// src/renderer/src/apps/api/hostGlobal.ts
import * as React from 'react'
import * as ReactDOM from 'react-dom/client'
import * as ReactJsxRuntime from 'react/jsx-runtime'

// Published before any extension module is imported, so an extension's react shim
// can resolve. See the plan's §1.2 for why this is a global rather than an import
// map or an ABI field.
//
// Frozen because this object is reachable from all renderer code: freezing removes
// the trivial footgun of one extension swapping the host's React out from under
// every other consumer. It is NOT a security boundary — a same-realm extension can
// reach window.api directly, and only the iframe transport changes that.
export function installHostGlobal(): void {
  Object.defineProperty(globalThis, '__agentCodeHost', {
    value: Object.freeze({
      react: React,
      reactDom: ReactDOM,
      jsxRuntime: ReactJsxRuntime,
      apiVersion: 1,
    }),
    writable: false,
    configurable: false,
    enumerable: false,
  })
}
```

- [ ] **Step 2: Call it first thing in `main.tsx`**, before `createRoot`.

- [ ] **Step 3: Verify** — `npm run dev`, console: `__agentCodeHost.apiVersion` → `1`,
  and `__agentCodeHost.react = null` throws.

- [ ] **Step 4: Commit.**

---

### Task B3: Extend the manifest with contributions

**Files:**
- Modify: `src/main/extensions/manifest.ts`
- Modify: `src/shared/types/extensions.ts`

The manifest schema built in the install phase covers identity and `entry` only. It
now needs `contributes` and `activationEvents`.

- [ ] **Step 1: Add the contribution schemas.** `commands[]` (`id`, `title`,
  `description?`, `keywords?`), `views[]` (`id`, `title`, `mount: 'modal'`),
  `settings[]` (`id`, `title`, `type: 'boolean'|'number'|'string'`, `default`),
  `keybindings[]` (`command`, `key`). All optional; an extension with no
  contributions is legal and does nothing visible.

- [ ] **Step 2: Namespace-check every contributed id.** A command id must start
  `<extensionId>.`. **WHY enforced rather than conventional:** ids land in one global
  command registry alongside ~95 first-party commands, and an extension declaring
  `session.kill` would shadow a real one. Rejecting at install is the only point where
  the user can still act on it.

- [ ] **Step 3: Reject duplicate ids within a manifest**, and record that
  cross-extension collisions are resolved at load time (first wins, second reported).

- [ ] **Step 4: Validate `activationEvents`** against the known set, allowing
  `onCommand:<id>` / `onView:<id>` only for ids this manifest declares. An activation
  event referencing a command the extension does not contribute is always an authoring
  mistake and is silently dead otherwise.

- [ ] **Step 5: Verify + commit.** Existing installs keep working — every new field is
  optional.

`TEST-SITE:` `manifest.test.ts` — namespace enforcement, duplicate ids, unknown
activation events.

---

### Task B4: The extension host

**Files:**
- Create: `src/shared/types/extensionModule.ts`
- Create: `src/renderer/src/apps/host/ExtensionHost.ts`
- Create: `src/renderer/src/apps/host/context.ts`

- [ ] **Step 1: Define the module contract**

```ts
// src/shared/types/extensionModule.ts
import type { AgentCodeApiV1 } from '@renderer/apps/api/types'

export type Disposable = { dispose(): void }

/** A view's renderer. DOM-level so React stays optional and the contract
 *  survives a future iframe transport — see plan §1.2. */
export type ViewMount = (element: HTMLElement) => void | (() => void)

export type ExtensionContext = {
  readonly api: AgentCodeApiV1
  registerCommand(id: string, run: () => void | Promise<void>): Disposable
  registerView(id: string, mount: ViewMount): Disposable
  readonly subscriptions: Disposable[]
}

/** What an extension's entry module must export. See plan §1.2. */
export type ExtensionModule = {
  activate(context: ExtensionContext): void | Promise<void>
  deactivate?(): void | Promise<void>
}
```

- [ ] **Step 2: Write the context factory** (`host/context.ts`). Creates one
  `ExtensionContext` per extension. `registerCommand`/`registerView` write into
  host-owned maps keyed by `extensionId`, return a `Disposable` that removes the
  entry, and **reject an id the manifest did not declare** — a registration the
  palette never heard of would be invisible, so failing loudly at registration is the
  only way the author finds out.

- [ ] **Step 3: Write `ExtensionHost`** (`host/ExtensionHost.ts`), owning the whole
  lifecycle:

```ts
// The one line of actual loading. @vite-ignore is required so Vite does not try to
// analyze a runtime specifier; Rollup passes a variable import() through untouched
// either way — Monaco's own foreign-module loader does exactly this in the shipped
// bundle, which is what retired the risk that it would not survive the build.
const url = `agent-code-ext://${id}/${manifest.entry}`
const module = (await import(/* @vite-ignore */ url)) as ExtensionModule
```

  Responsibilities:
  - `activate(id)` — import once, call `module.activate(context)`, memoize the
    in-flight promise so two concurrent triggers activate once.
  - `deactivate(id)` — call `deactivate?.()`, then dispose `subscriptions` in reverse
    order, then drop the module reference.
  - **Every failure is a value, never a throw.** A module that fails to import, has
    no `activate`, or throws inside it, records `{ id, error }` and leaves every
    other extension running. A broken third-party module must not be able to blank
    the app.
  - Activation-event dispatch: `onStartupFinished` after mount, `onCommand:` /
    `onView:` on first use, `*` immediately.

- [ ] **Step 4: Verify** typecheck. **Step 5: Commit.**

`TEST-SITE:` `ExtensionHost.renderer.test.ts` — double-activation memoization,
disposal order, a throwing `activate` isolated from siblings.

---

### Task B5: The view bridge

**Files:**
- Create: `src/renderer/src/apps/host/viewBridge.tsx`

- [ ] **Step 1**

```tsx
// src/renderer/src/apps/host/viewBridge.tsx
import { useEffect, useRef } from 'react'

import type { ViewMount } from '@shared/types/extensionModule'

/**
 * Wraps a registered ViewMount in a host-owned React component, so everything
 * downstream — AppHostSurface, AppDefinition, the command registry — is unchanged by
 * extensions being loaded at runtime rather than compiled in.
 *
 * This component is the entire adapter between the host's React world and the
 * extension's DOM world, and it is the piece that gets REPLACED (not rewritten) if
 * extensions later move into an iframe: `mount(element)` is exactly what the
 * child-side bootstrap calls over there.
 */
export function viewComponentFor(mount: ViewMount) {
  return function ExtensionView() {
    const hostRef = useRef<HTMLDivElement | null>(null)

    useEffect(() => {
      const element = hostRef.current
      if (!element) return

      let cleanup: void | (() => void)
      try {
        cleanup = mount(element)
      } catch (error) {
        // A throw from third-party code during mount. Contained here rather than
        // allowed to unwind into the host tree, where React would unmount to the
        // root and blank the entire application.
        element.textContent = `Extension view failed: ${
          error instanceof Error ? error.message : String(error)
        }`
        return
      }

      return () => {
        try {
          cleanup?.()
        } catch {
          // A throwing cleanup must not prevent the host from unmounting. The
          // extension leaks whatever it leaked; the app stays usable.
        }
        element.replaceChildren()
      }
    }, [])

    return <div ref={hostRef} style={{ display: 'contents' }} />
  }
}
```

`TEST-SITE:` `viewBridge.renderer.test.tsx` — cleanup runs on unmount; a throwing
`mount` renders the error instead of propagating.

- [ ] **Step 2: Verify** typecheck. **Step 3: Commit.**

---

### Task B6: Wire declarations into the app

Declared contributions must reach the palette, Settings and the keybinding router
**without the extension having been activated**. This is the task the superseded plan
under-priced: `APPS`, `APP_BY_ID`, `appCommands`, `commandDefs` and
`listPickerCommandMeta()` are all module-scope snapshots.

**Files:**
- Modify: `src/renderer/src/apps/registry.ts`
- Modify: `src/renderer/src/apps/commands/appCommands.ts`
- Modify: `src/renderer/src/features/command-palette/registry.ts`
- Modify: `src/renderer/src/app-state/uiShell/{types,slice}.ts`, `app-state/types.ts`
- Modify: `src/renderer/src/app/App.tsx`
- Modify: `src/renderer/src/apps/ui/AppsSettingsRow.tsx`

- [ ] **Step 1: Put the installed set in the store.** `installedExtensions:
  ExtensionListEntry[]`, `extensionErrors: {id,name,error}[]`, and a setter on the
  uiShell slice. **WHY the store and not a module variable:** the palette and Settings
  must re-render when the set changes, and a module-scope array cannot notify them.
  `apps/registry.ts` keeps only a `BUILTIN_APPS: AppDefinition[] = []` seam.

- [ ] **Step 2: Derive commands from DECLARATIONS, not from loaded modules.**
  `buildExtensionCommands(installed)` maps every `contributes.commands[]` entry to a
  `CommandDef` whose `run` calls `extensionHost.executeCommand(extId, cmdId)` — which
  activates the extension first if needed. **This is what makes lazy activation
  work**: the command is listed and invocable before a single byte of the extension
  has been imported.

- [ ] **Step 3: Derive views the same way.** A `contributes.views[]` entry with
  `mount: 'modal'` produces an `AppDefinition` whose `Component` activates on first
  render and then renders the registered `ViewMount` through `viewComponentFor`.
  Derive `APP_BY_ID` at the point of use, not at module scope — a module-scope map
  against a live array is a silently-missing extension.

- [ ] **Step 4: Make `commandDefs` a function.** `buildCommandDefs(extensionCommands)`,
  called from `buildCommandRegistry`. Check `listPickerCommandMeta()` — Settings'
  command-visibility row consumes it, so extension commands should appear there and be
  hideable like any other.

- [ ] **Step 5: Contributed settings.** Render `contributes.settings[]` under the
  extension's own section, persisted through `extensionStorage*` under a reserved
  `__settings` key. **WHY not the Settings store:** third-party-declared fields must
  never enter the zustand-persist blob (#249), and per-extension storage already
  exists and is namespaced.

- [ ] **Step 6: Contributed keybindings.** `useKeybinds.ts` is one hardcoded
  capture-phase listener with no registry. Add a single consulted map of
  extension bindings, checked **after** every first-party branch. **WHY after:** an
  extension must not be able to shadow ⌘W or ⌘T. Conflicts are reported in Settings,
  not silently resolved.

- [ ] **Step 7: Load the list on startup and after install/remove.** In `App.tsx`, one
  effect reads `extensionsList()` into the store and fires `onStartupFinished`
  activations. `AppsSettingsRow` refreshes the same store after install/remove, so an
  extension is usable without a restart — the thing that makes this an extension
  system rather than a config file. **WHY an effect rather than blocking bootstrap:**
  the renderer mounts synchronously, and making the app wait on third-party module
  evaluation lets one slow extension delay startup for everything.

- [ ] **Step 8: Verify** typecheck + `npm test` + build.

- [ ] **Step 9: Commit.**

---

### Task B7: Fix the inherited defects

**Files:**
- Modify: `src/renderer/src/ui/GlobalToast.tsx`
- Modify: `src/renderer/src/apps/api/useAppHostApi.ts`
- Modify: `src/renderer/src/apps/api/types.ts`
- Modify: `src/renderer/src/features/command-palette/ui/CommandPalette.tsx`

- [ ] **Step 1: Toast above modals.** Raise `GlobalToast` from `z-50` to above
  `z-[1100]`. **WHY the toast and not the dialog:** a toast is by definition the
  topmost transient layer — every other caller is non-modal chrome that is
  unaffected by raising it, whereas lowering the dialog would break the modal
  stacking the whole surface registry depends on.

- [ ] **Step 2: `theme.tokens()` must include runtime-only tokens.** Union the
  stylesheet-discovered names with an explicit list of the tokens `theme.ts` assigns
  at runtime (`--theme-app-font`, `--theme-font-code`, accent pair). **WHY explicit:**
  they are set via `style.setProperty` on the root and never appear in any
  stylesheet, so no amount of walking `document.styleSheets` will find them.

- [ ] **Step 3: `JsonValue` must not admit non-finite numbers.** Document that
  `JSON.stringify` turns `NaN`/`Infinity` into `null`, and reject them in
  `extensionStorageSet` with a clear error rather than silently corrupting.

- [ ] **Step 4: Add `openApp` to the `useMemo` dep array** in `CommandPalette.tsx`.

- [ ] **Step 5: Verify + commit.**

---

## 3. Phase C — the SDK and a real extension

Phase B is unverifiable without something to install. This phase produces it, and it
is the honest end-to-end test.

- [ ] **Task C1 — `agent-code-extension-api` package.** A published (or
  git-installable) package exporting the `AgentCodeApiV1` and `ExtensionModule`
  types, the react shim, and a Vite config preset that marks react external and
  points bare specifiers at `globalThis.__agentCodeHost`. **WHY a package rather than
  documentation:** the shim and the externals config are exactly the parts an author
  will get wrong, and they are copy-paste identical for everyone.

- [ ] **Task C2 — `Juliusolsson05/timer-extension`.** A separate repository. The
  timer that was deleted from this one, rebuilt against the SDK:
  `agent-code.extension.json`, `src/index.tsx` exporting `mount`, a build producing
  `dist/index.js`, and a release tag. The SVG ring, presets, pause/resume and
  deadline-based countdown from the deleted version are a reasonable starting point.

- [ ] **Task C3 — the end-to-end run.** Settings → paste `Juliusolsson05/timer-extension`
  → Install → `Open Timer` in the palette → it runs. **This is the acceptance test
  for the entire platform**, and until it passes, nothing above is verified.

- [ ] **Task C4 — `docs/extensions/authoring.md`.** Manifest reference, the `mount`
  contract, the Tier 0 API, the theme tokens, and how to publish. Generated from the
  zod schema where possible so it cannot drift.

---

## 4. Phase D — beyond Tier 0

Deliberately unplanned in detail; each item needs a real consumer before its contract
is designed. Recorded so the sequencing is not re-derived.

- **Tier 1 (`workspace.observe`, `sessions.observe`, `panes.observe`)** — metadata
  and status events, no transcripts. `main/remote/SessionFeedSource.ts` already
  projects session state for the mobile client and is the template.
- **Tier 2 (`fs.read`, `transcript.read`, `git.read`)** — requires a consent flow.
  `WorkflowSourceApprovalStore` is the in-repo precedent.
- **Tier 3 (`sessions.prompt`, `fs.write`, `git.commit`, `network.fetch`)** —
  requires per-extension identity that is *enforceable*, which same-realm loading
  cannot provide. **This is the gate that forces Phase D2.**
- **D2 — iframe isolation.** Priced at ~350–650 LOC by the frame-boundary audit:
  keyboard routing and default suppression are the bulk (every host shortcut dies
  while focus is in a frame, and Cmd+W closes the window), plus an unhandled-Escape
  bridge, a splitter drag shield, and a theme stylesheet contract. The DOM-level
  `mount` contract from §1.1 is what makes this a transport change rather than a
  rewrite.
- **Background extensions.** An extension that only runs while its modal is open
  cannot be a timer, a watcher, or a notifier. Needs extension state to live above
  the surface, and a decision about what a backgrounded extension may do. **This is
  a product decision, not a technical one, and it should be made deliberately rather
  than falling out of an implementation.**

---

## 5. Acceptance for the platform as a whole

- [ ] `agent-code-ext://` resolves in `npm run dev` **and** in a packaged build.
- [ ] A path-traversal URL returns 403, verified by hand.
- [ ] An extension installs from a repo with no releases and one with releases.
- [ ] An extension with a bad manifest fails with a message naming the problem.
- [ ] An extension whose entry throws shows an error and does not blank the app.
- [ ] Removing an extension removes its command and its bundle, and keeps its state.
- [ ] Reinstalling restores it without a restart.
- [ ] `npm run typecheck`, `npm test`, `npm run build` all pass.
- [ ] The timer extension runs from its own repository, and no extension source
      exists anywhere in this one.
