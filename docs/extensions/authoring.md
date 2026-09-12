# Writing an Agent Code extension

> **Status:** this branch implements API versions **1 and 2**. API v2 requires
> the host and SDK changes in PR #577 and companion SDK PR #1.
>
> This document is the contract. Where it and the code disagree, the code wins and
> this document is the bug — it has been wrong before, in the way described in §3.

An extension is a GitHub repository or local folder containing a manifest and
built ES modules. Agent Code validates and snapshots the bundle, then runs its
code in isolated browser contexts. Nothing is compiled into the app.

```
Settings → Extensions → owner/repo → Install
```

---

## 0. Runtime and view ownership

API v2 separates two browser contexts. One sandboxed, hidden runtime owns an
extension's commands and shared state. Every open view runs a separate module in
its own sandboxed iframe at `agent-code-ext://<extension-id>/`. Closing the last
view leaves the runtime alive. A command can activate it without opening a view.

A view owns DOM, theme and window-specific UI; a runtime has no implicit focused
window or project. Functions never cross this boundary. Views send named JSON
requests to the runtime and subscribe to published JSON state. Both contexts have
namespaced durable storage; module variables and browser localStorage are not a
persistence contract across app restart or replacement.

Bundle your own dependencies, including React. There is no host React instance,
Node API or generic application preload available to extension code. Cross-origin
DOM access, external network requests, popups, top-level navigation, nested frames
and permission prompts are denied by the host's sandbox and policy.

API v1 remains supported with its original per-view `activate/registerView`
contract. It does not gain a shared background runtime; see compatibility below.

## 1. Manifest and activation

Put `agent-code.extension.json` at the repository root:

```json
{
  "id": "counter",
  "name": "Counter",
  "description": "Shared state across independent views.",
  "version": "0.1.0",
  "apiVersion": 2,
  "entry": "dist/runtime.js",
  "activationEvents": ["onCommand:counter.increment", "onView:counter.main"],
  "contributes": {
    "commands": [
      { "id": "counter.open", "title": "Counter: Open" },
      { "id": "counter.increment", "title": "Counter: Increment" }
    ],
    "views": [
      { "id": "counter.main", "title": "Counter", "mount": "panel", "entry": "dist/view.js" }
    ],
    "settings": [
      { "id": "counter.step", "title": "Increment amount", "type": "number", "default": 1 }
    ]
  }
}
```

| Field | Rules |
| --- | --- |
| `id` | `/^[a-z][a-z0-9-]{0,63}$/`; permanent storage namespace and origin host. |
| `name`, `description` | Required, nonempty display metadata. |
| `version` | Display text, recorded without version ordering. |
| `apiVersion` | This host accepts `1` and `2`; checked at install and load. |
| `entry` | Built runtime ES module for v2; legacy activation module for v1. |
| `contributes.views[].entry` | Required for v2. Built view ES module, independent of runtime. |
| `contributes.themes` | Up to 16 declarative palettes; see §7. No runtime activation or permission. |
| Entry paths | Relative `.js`/`.mjs` paths within the bundle; no `..`, backslashes or absolute paths. Installer validates actual files and symlink containment. |
| Contribution ids | Must start with `<extension-id>.`. |
| `permissions` | Only implemented capabilities are accepted; see §6. |

Contributions are discoverable before any author code executes. A v2 cold runtime
starts only for an explicit event: `onStartupFinished` or `*` starts it after host
startup and after installation/update; `onCommand:<declared-id>` or
`onView:<declared-id>` permits that command or view to start it lazily. Absent
activation events never start a cold runtime. Once active, registered commands
execute without requiring another matching activation event.

A command matching a view id opens that view. `<extension-id>.open` also opens the
view of a single-view extension. Other v2 commands run in the shared runtime and
return an acknowledged result/error; they do not open a view. Declare startup or
command activation for command-only extensions.

## 2. Independent modules

The SDK's `defineRuntime` and `defineView` helpers return their module objects.
Named `activate`/`mount` exports also work. See the
[SDK counter fixture](../../packages/agent-code-extension-api/examples/counter)
for a typed example built and installed by the real Electron integration test.

```ts
// src/runtime.ts
import { defineRuntime } from 'agent-code-extension-api'

export default defineRuntime({
  async activate(context) {
    let count = (await context.api.storage.get<number>('count')) ?? 0
    context.registerCommand('counter.increment', async () => {
      const step = (await context.api.storage.get<number>('counter.step')) ?? 1
      const next = count += step
      // Shutdown revokes write authority and has a deadline; persist on mutation.
      await context.api.storage.set('count', next)
      await context.views.publish('counter.main', { count: next })
      return next
    })
    context.registerRequest('readCount', (_input, view) => ({ count, instanceId: view.instanceId }))
    await context.views.publish('counter.main', { count })
  },
})
```

```ts
// src/view.ts
import { defineView } from 'agent-code-extension-api'

export default defineView<{ count: number }>({
  mount(element, context) {
    const render = (state: { count: number } | undefined) => {
      element.textContent = `Count: ${state?.count ?? 0}`
    }
    render(context.runtime.state())
    return context.runtime.subscribe(render)
  },
})
```

`views.publish(viewId, json)` replaces that view type's latest state for all its
attached instances. `runtime.state()` reads the current snapshot, possibly
undefined before the first publication; `subscribe` receives subsequent changes.
`runtime.request(name, input)` invokes a registered request handler with validated
JSON and a host-issued `{ id, instanceId }`. Validate your application's input
shape in the handler; transport validation only establishes bounded JSON.

Runtime messages allow at most 4096 JSON values, depth 32 and 128 Ki characters.
Startup has a 10-second deadline; an invocation has 30 seconds, with at most 32
pending calls per extension. Keep published state compact and coalesce rapid UI
changes instead of treating the bridge as an unbounded event stream.

Closing a view rejects pending replies and prevents calls still awaiting startup
from dispatching. An already dispatched action may finish. Requests and commands
are never automatically replayed; a command timeout reports an unknown outcome.

View `mount` and returned cleanup are synchronous. Mount runs after runtime
attachment and theme delivery. Runtime `deactivate` and subscriptions may be async,
but normal retirement revokes API authority immediately and allows at most 500 ms
for cleanup. Forced termination may skip cleanup entirely. Use subscriptions to
release local timers/listeners; save durable state when it changes.

### View placement and keyboard behavior

`mount: "modal"` opens an automatically sized floating dialog; `"panel"` opens a
workspace pane. Restored panes retain their extension/view identity and display a
missing-extension state when the bundle is unavailable.

Application shortcuts inside cross-origin views use the host's configured
keybindings. Genuine keyboard input selects the focused extension pane before
routing its command, so closing a pane targets that view. In a modal, palette
access and the configured close command remain available; close dismisses the
modal, while native editing stays in the view. Extension-dispatched DOM events
and messages cannot invoke this application shortcut route.

Escape is forwarded to the host unless the view calls
`event.preventDefault()`; unhandled Escape closes the view. Provide visible
controls where needed, and use `context.api.ui.close()` to close your own view.

### API v1 compatibility

A v1 entry exports `activate(context)` and optionally `deactivate()`, or uses
`defineExtension`. Its context supports `registerCommand` and
`registerView(id, element => cleanup)`. That module activates separately in every
visible view. Its activationEvents are validated metadata, with no background
execution. A cold non-view command opens the sole declared view to dispatch; a
viewless v1 extension cannot execute an action cold.

Legacy view cleanup, deactivate and subscriptions run synchronously on document
teardown, with subscriptions visited in reverse order. Migrate shared command/state
ownership to a v2 runtime, move DOM work to view modules, declare each view's entry,
and choose explicit activation events. Changing only `apiVersion` is insufficient.

---

## 3. React (and every other dependency): bundle it

**Bundle your own React. Normally. Like any web app.**

If you have seen an older version of this document telling you to alias `react` to
`globalThis.__agentCodeHost` — that guidance was for a previous architecture where
extensions ran inside Agent Code's own renderer and would have collided with the
host's React instance. **It is wrong now and will break your extension**, because a
cross-origin frame cannot see the host's globals at all: the shim would read
`undefined` at module-evaluation time and your extension would fail before
`activate()` ran.

Your frame is its own document with its own realm. Two React instances in two
documents are not a conflict; they never meet.

The SDK ships types and a Vite preset that produces the right output. It is **not
on npm** — install it from GitHub, which works because its `dist/` is committed:

```bash
npm i -D github:Juliusolsson05/agent-code-extension-api
```

```ts
// vite.config.ts
import { extensionViteConfig } from 'agent-code-extension-api'
export default extensionViteConfig({
  entries: { runtime: 'src/runtime.ts', view: 'src/view.ts' },
})
```

The SDK is optional. It gives you `ExtensionManifest`, `ExtensionContext` and
`AgentCodeApiV1` types plus the build preset; an extension is a plain ES module and
nothing in the host requires you to depend on it.

---

## 4. Build output

Two hard requirements:

1. **Built ES modules** at the runtime and every v2 view entry path. Commit all
   imported shared chunks too; the installer serves contained bundle assets.
2. **Committed to the repository.** The installer downloads your repo's source
   tarball, not a release asset, so a `dist/` that only exists in CI means every
   install fails with *"Manifest points at … which does not exist"*.

For a legacy v1 single-entry build without the preset:

```ts
build: {
  lib: { entry: 'src/index.ts', formats: ['es'], fileName: () => 'index.js' },
  rollupOptions: { output: { inlineDynamicImports: true } },
  cssCodeSplit: false,
},

// REQUIRED if you depend on anything from the React ecosystem.
define: { 'process.env.NODE_ENV': JSON.stringify('production') },
```

### ⚠️ `process is not defined` — read this before you debug it

**Vite's library mode does not replace `process.env.NODE_ENV`.** A normal app build
does; a library is expected to leave it for the consuming bundler. There is no
consuming bundler here — your output is loaded straight into a browser document
where `process` does not exist.

Nearly every React-ecosystem package guards its dev warnings with
`process.env.NODE_ENV !== "production"`, so the first one to execute throws and
your extension fails during `activate()` — **after** installing and importing
cleanly, which makes it look like your code rather than your build.

The `define` above is the fix. Do **not** shim a global `process` object instead:
libraries would then take Node code paths inside a browser realm, which fails later
and far less obviously.

**CSS must be loaded by your view.** The host does not automatically request
emitted sibling stylesheets. Import CSS with `?inline` and inject a `<style>` tag,
or explicitly load a contained stylesheet from your view module.

**Symlinks must be relative.** If your bundle aliases a file with a symlink, make
it relative. An absolute symlink points outside the installed bundle once the
extension has been copied into place, and the installer refuses it.

---

## 5. The API

The v2 runtime API provides identity and storage. The v2 view API (and v1 context
API) additionally provides UI, theme and permissioned observation below. Remote
reads/actions return Promises; view state reads and subscription setup are local
synchronous operations. Background runtimes have no implicit window-scoped
observation or UI API.

### Tier 0 — always available, no permission needed

```ts
api.extension.id                     // your id
api.extension.apiVersion             // 1 or 2, matching your manifest

api.storage.get(key)                 // your own namespace, persisted
api.storage.set(key, value)
api.storage.delete(key)
api.storage.keys()

api.ui.close()                       // close your view (the modal or the pane)
api.ui.showToast(message)            // app-wide toast

api.theme.tokens()                   // resolved --theme-* values
```

### Tier 1 — requires a permission (see §6)

```ts
api.workspace.observe()              // { activeTabId, tabIds, sessionCount }
api.workspace.subscribe(listener)    // returns an unsubscribe

api.sessions.observe()               // [{ id, kind, cwd, title }]
api.sessions.subscribe(listener)

api.panes.observe()                  // [{ tabId, leafSessionIds }]
api.panes.subscribe(listener)
```

`subscribe` gives you a change *nudge* carrying no data — re-read with `observe()`
when it fires. Calling `observe()` without the matching permission rejects.

### Tier 2 — scoped project files (API v2)

```ts
const file = await api.files.readText({
  sessionId: 'the-session-you-are-targeting',
  path: 'src/index.ts',
})
```

Declare `"fs.read"` in `permissions`. The session must still be active, and main
derives its project root from the session's spawn record. Paths are relative to
that root; absolute paths, traversal, symlink escapes, directories, binary data and
invalid UTF-8 reject. Reads are capped at 96 KiB so their result fits the bounded
extension transport. Both the v2 runtime and its views expose the same method.

There is deliberately no implicit focused session. Background code has no focused
window, and a view's focus can change while an asynchronous read is pending. Use a
session id from your own workflow or from `sessions.observe` when that separately
granted metadata permission is appropriate.

### Reading a contributed setting

A `contributes.settings` entry renders a row in Agent Code's Settings, and the value
the user picks is written to **your own storage under the setting's full id**. The
manifest `default` is what the row displays before anything is stored; it is not
written for you. So read it with the same default:

```ts
const minutes = (await api.storage.get('timer.defaultMinutes')) ?? 30
```

### Storage notes

- Namespaced by extension id; you cannot read another extension's data.
- Values must be JSON-serializable. **`NaN` and `Infinity` are rejected** rather
  than silently stored as `null`.
- Keys may not be `__proto__`, `constructor` or `prototype`.
- Concurrent writes are serialized, so `void set('a',1); void set('b',2)` is safe.
- **Survives uninstall.** Uninstall-then-reinstall is a normal troubleshooting
  move; destroying user data as a side effect of it would be hostile.
- A modal, pane and runtime of the same extension share one namespace.
- Each namespace is limited to 256 keys and 1 MiB of encoded state. Each value
  must also fit the bounded JSON transport limits. Over-limit writes preserve the
  previous snapshot; use compact application state rather than large file contents.
- Reads and writes are ordered together, with at most 32 pending operations per
  extension and 256 globally. A rejected burst can be retried after it drains.
- Corrupt, unreadable or oversized saved files produce an error and are preserved.
  They are never treated as empty and overwritten by the next mutation.

---

## 6. Permissions

Declare what you need in `permissions`. The user approves them in a blocking
dialog at install time, and the grant is bound to the exact bytes installed — if
you ship new code, the user is asked again.

**Four permissions are currently implemented:**

| Permission | Grants |
|---|---|
| `workspace.observe` | `api.workspace.observe` / `subscribe` |
| `sessions.observe` | `api.sessions.observe` / `subscribe` |
| `panes.observe` | `api.panes.observe` / `subscribe` |
| `fs.read` | API v2 `api.files.readText({ sessionId, path })` in runtimes and views |

Anything else fails the install with a message naming what this build supports.
Filesystem writes, transcript, git, prompt-sending and network capabilities **do
not exist** — they are unimplemented, and asking for one is an install error rather
than a silent no-op. `fs.read` requires API v2 because v1's per-view API is frozen.
Omit `permissions` entirely to stay Tier 0, which installs with no prompt at all.

---

## 7. Theming

Agent Code pushes its palette into your frame as `--theme-*` custom properties,
**before** your view mounts, and again whenever the theme changes. Use them in CSS
and you inherit the user's theme for free:

```css
.my-extension {
  background: var(--theme-surface);
  color: var(--theme-ink);
  border: 1px solid var(--theme-border);
}
```

Common tokens: `--theme-canvas`, `--theme-surface`, `--theme-ink`,
`--theme-ink-dim`, `--theme-muted`, `--theme-border`, `--theme-accent`,
`--theme-accent-fg`, `--theme-font-code`.

You do not need a fallback palette — the tokens are guaranteed present before your
first paint. Prefer plain CSS over `api.theme.tokens()`; the accessor exists for
canvas and inline-SVG consumers that cannot use the cascade.

**Only the `--theme-*` layer is contract.** The `--color-*` Tailwind bindings are
an implementation detail of how the app wires its utilities.

### Contributing an application theme

Both manifest versions accept declarative themes. They appear in the appearance
picker without executing your extension or requiring an extra permission:

```json
"themes": [{
  "id": "counter.night",
  "title": "Counter Night",
  "colors": { "canvas": "#102030", "ink": "#f0e0d0", "accent": "#78abcd" }
}]
```

Place this array inside `contributes`, with ids in your extension's namespace.
The SDK exports `EXTENSION_THEME_COLOR_KEYS` and `ExtensionThemeContribution`.
Only those color tokens are accepted; omitted tokens inherit the default palette.
Values must be `#RGB`, `#RGBA`, `#RRGGBB`, `#RRGGBBAA`, or `transparent`. CSS
functions, variables, URLs and non-color properties are rejected. Each theme
needs at least one color; a manifest can contain at most 16 themes.

The user selects the theme. Updating your bundle replaces its palette, while
uninstall falls back to Dark and preserves the selection for reinstall. Themes
do not overwrite built-ins, saved user themes, font choices or corner settings.
The picker identifies the providing extension; New theme copies the current
colors into a separate user-owned palette.

---

## 8. Developing locally

Cutting a GitHub release for every change is not a dev loop. Use **Load folder…**:

```
Settings → Extensions → Load folder… → pick your built folder
```

That takes a *snapshot copy* of the folder through the exact same validation as a
GitHub install. Rebuild, press **Reload** on the extension's row, and reopen your
view. Because the grant is bound to the installed bytes, a rebuild that changes
installed bytes asks for consent again when permissions are requested.

---

## 9. Publishing

```bash
npm run build          # produces the declared runtime/view files and shared chunks
git add dist && git commit
git tag v0.1.0 && git push --tags
gh release create v0.1.0
```

Agent Code prefers **the latest release tag** and falls back to the default
branch — a release is the author saying *this is ready*, whereas a branch is
whatever was pushed thirty seconds ago. Either way it downloads the **source
tarball**, which is why `dist/` must be committed.

The installer records the resolved ref, a SHA-256 of the tarball, and a SHA-256 of
the installed bundle, so "which bytes am I running" stays answerable.

Archives are capped at **32 MB**.

---

## 10. Failure modes you will hit

| Symptom | Cause |
|---|---|
| *"Repository has no agent-code.extension.json"* | manifest missing, or not at the repo root |
| *"Manifest points at … which does not exist in the repository"* | `dist/` not committed, or a wrong `entry` |
| *"contribution id … must start with …"* | a contributed id outside your namespace |
| *"registerCommand(x) — not declared"* | id missing from `contributes.commands` |
| *"entry module does not export an activate(context) function"* | wrong export, or the bundle is not an ES module |
| *"unknown capability … not available yet"* | you asked for a permission this build does not implement (§6) |
| *"extension targets Agent Code API v2, this build implements v1"* | Agent Code is older than your extension |
| *"The repository contains a symlink … that points outside"* | make internal symlinks relative (§4) |
| *"Extension failed to load: process is not defined"* | missing `define` — see §4 |
| *"The extension frame did not start"* | the bundle could not be served or was blocked by the frame CSP |
| renders unstyled | emitted CSS was never loaded by the view |
| `fetch` fails | you have no network access — see §0 |
| a shortcut does nothing while your view has focus | check Settings bindings and command context; modals expose palette/close while retaining native editing (§2) |

Install/load failures appear in Settings. Frame startup errors appear in the view
with Retry, and rejected commands reach the host command error path. Background
startup failures still need a dedicated management status surface; they currently
reach host diagnostics. One failed extension does not prevent others from starting.

---

## 11. What v1 deliberately does not have

Recorded so you know these are decisions, not oversights:

- **No background execution.** Activation events do not fire; your code runs while
  a view of yours is open (§1).
- **No network.** The frame's CSP permits only your own origin (§0).
- **No filesystem, transcript, git or prompt access.** The scoped filesystem API
  belongs to v2; v1 remains frozen (§6).
- **No marketplace.** The repo name is the trust decision.
- **No cross-extension communication.** Each extension is its own origin and cannot
  see another's frame, storage, or bundle.
