# Writing an Agent Code extension

> **Status:** live. API version **1**.
>
> This document is the contract. Where it and the code disagree, the code wins and
> this document is the bug — it has been wrong before, in the way described in §3.

An extension is a **GitHub repository** containing a manifest and a built ES
module. Agent Code downloads it, validates it, and runs it **inside a sandboxed
iframe at its own origin**. Nothing is compiled into the app.

```
Settings → Extensions → owner/repo → Install
```

---

## 0. The execution model — read this first

Your extension does **not** run in Agent Code's renderer. It runs in a separate
document served from `agent-code-ext://<your-id>/`, embedded in a sandboxed
`<iframe>`.

Everything else in this document follows from that one fact:

- **You are a normal web page.** Bundle whatever you like. React, Preact, Svelte,
  a canvas, plain DOM — no framework negotiation with the host, because you do not
  share a realm with it.
- **You cannot reach the host.** Not `window.parent`'s DOM, not Agent Code's
  internals, not another extension. Your only channel is the `api` object handed to
  `activate()`, which is brokered over `postMessage` and validated on the far side.
- **You have no network access.** The frame's Content-Security-Policy is
  `connect-src` your own origin only. `fetch` to any other host fails. So does
  `window.open`, form submission, top-level navigation, and creating a nested
  frame. This is deliberate: an extension that could phone home would make the
  install prompt meaningless.
- **You get a fresh document every time your view opens**, and it is destroyed when
  the view closes. Persistent state belongs in `api.storage`, not in a module-level
  variable.

---

## 1. The manifest

`agent-code.extension.json`, at the repository root.

```jsonc
{
  "id": "timer",
  "name": "Timer",
  "description": "Focus timer with interval reminders.",
  "version": "0.1.0",
  "apiVersion": 1,
  "entry": "dist/index.js",

  "contributes": {
    "commands": [
      { "id": "timer.open",  "title": "Open Timer", "keywords": ["pomodoro"] },
      { "id": "timer.start", "title": "Start Timer" }
    ],
    "views": [
      { "id": "timer.main", "title": "Timer", "mount": "modal" }
    ],
    "settings": [
      { "id": "timer.defaultMinutes", "title": "Default duration",
        "type": "number", "default": 30 }
    ],
    "keybindings": [
      { "command": "timer.start", "key": "cmd+shift+t" }
    ]
  }
}
```

| Field | Rules |
|---|---|
| `id` | `/^[a-z][a-z0-9-]{0,63}$/`. Becomes a directory name, your storage namespace, and your origin's host. **Permanent** — renaming orphans user data. |
| `name`, `description` | Required, non-empty. `description` is shown in the palette and Settings. |
| `version` | Free text. Displayed and recorded; never parsed. |
| `apiVersion` | Must equal the host's. `1` today. Checked at install **and on every launch** — a host that implements only v1 refuses a v2 manifest with a message saying so. |
| `entry` | Relative path to a built ES module. No absolute paths, no `..`, no backslashes, must end `.js`/`.mjs`. |
| `contributes.*.id` | Must start with `<your id>.`. Enforced at install. |
| `permissions` | See §6. Only three values are accepted today. |

### Why contributions are declared

The palette and Settings need to know what you offer **before your code has been
loaded**. That is what makes lazy loading possible — a command can be listed and
invoked while your module has never been imported. It also means a *broken*
extension still shows what it contributes, with the failure reason next to it,
instead of vanishing.

### Activation events

`activationEvents` is accepted and validated (an event naming a contribution you do
not declare fails the install), but **no activation event fires in this version.**
Do not rely on it.

What actually happens: your module is imported and `activate()` is called when one
of your views opens — either directly, or because a contributed command with no
matching view opened your single view in order to run. There is no background
execution while every view of yours is closed.

The practical consequence, using the reference timer as the example: a deadline
stored in `api.storage` is correctly restored when the view opens, so no *time* is
lost — but a reminder does not fire while the view is closed. If your extension
needs to do work with no window open, v1 cannot support it. This is tracked as the
background-frame follow-up; the fix has to be a hidden frame, because running an
extension in the host realm is exactly what the sandbox exists to prevent.

---

## 2. The module

Your `entry` must export `activate`, and may export `deactivate`.

```ts
export function activate(context) {
  context.subscriptions.push(
    context.registerCommand('timer.start', () => { /* … */ }),
    context.registerView('timer.main', element => {
      element.textContent = 'hello'
      return () => { /* cleanup when the view closes */ }
    }),
  )
}

export function deactivate() { /* optional */ }
```

- **`registerCommand`/`registerView` reject an id you did not declare.** A handler
  the palette has no entry for could never be invoked, so this fails loudly rather
  than leaving you with a dead command and no clue why.
- **A view mount may return a cleanup function.** It runs when the view closes.
- **`deactivate()` runs when the view closes**, after the view's own cleanup.
- **Everything in `context.subscriptions` is disposed** after that, in reverse
  order.

Teardown order on close is: view cleanup → `deactivate()` → subscriptions in
reverse. It is best-effort and synchronous, because the document is being
destroyed — do not `await` anything you need to complete.

### Views are DOM-level

```ts
type ViewMount = (element: HTMLElement) => void | (() => void)
```

You get an empty element. Do whatever you like inside it:

```tsx
import { createRoot } from 'react-dom/client'

context.registerView('timer.main', element => {
  const root = createRoot(element)
  root.render(<App />)
  return () => root.unmount()
})
```

### Where a view appears

`mount` in the manifest decides which host shell opens your view:

- `"modal"` — a floating dialog. It sizes itself to your content: report your
  natural size by simply laying out normally, and the host measures it. An
  oversized view is scaled down to fit the window rather than clipped.
- `"panel"` — a **pane** in the tiled workspace, alongside agent and terminal
  panes. Your view fills the tile.

Both are implemented. A pane persists across restarts: Agent Code remembers which
view the pane hosts and rebuilds it on launch, showing a "not installed" message if
the extension is gone.

**Keyboard caveat for both shells:** because your view is a cross-origin frame,
keystrokes inside it never reach Agent Code. While focus is inside your view, app
shortcuts — including Escape and the command palette — do not fire. Give the user a
visible way out: a close button, or call `api.ui.close()`. The host's own modal
close button is always available.

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

The SDK ships a Vite preset that produces the right output:

```ts
// vite.config.ts
import { extensionViteConfig } from 'agent-code-extension-api'
export default extensionViteConfig()
```

---

## 4. Build output

Two hard requirements:

1. **A single ES module** at the manifest's `entry` path.
2. **Committed to the repository.** The installer downloads your repo's source
   tarball, not a release asset, so a `dist/` that only exists in CI means every
   install fails with *"Manifest points at … which does not exist"*.

If you are not using the preset:

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

**CSS must be inlined by your bundle**, not emitted as a sibling file. Vite's
library mode emits `style.css` regardless of `cssCodeSplit`, and the host imports
exactly one file — a stylesheet nothing requests silently never applies. Import it
`?inline` and inject a `<style>` tag yourself.

**Symlinks must be relative.** If your bundle aliases a file with a symlink, make
it relative. An absolute symlink points outside the installed bundle once the
extension has been copied into place, and the installer refuses it.

---

## 5. The API

Your `context.api` is `AgentCodeApiV1`. **Every method returns a Promise**, with no
exceptions — a future transport cannot be made synchronous, and widening a
signature later would touch every call site in every extension.

### Tier 0 — always available, no permission needed

```ts
api.extension.id                     // your id
api.extension.apiVersion             // 1

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

### Storage notes

- Namespaced by extension id; you cannot read another extension's data.
- Values must be JSON-serializable. **`NaN` and `Infinity` are rejected** rather
  than silently stored as `null`.
- Keys may not be `__proto__`, `constructor` or `prototype`.
- Concurrent writes are serialized, so `void set('a',1); void set('b',2)` is safe.
- **Survives uninstall.** Uninstall-then-reinstall is a normal troubleshooting
  move; destroying user data as a side effect of it would be hostile.
- A modal and a pane of the same extension share one namespace.

---

## 6. Permissions

Declare what you need in `permissions`. The user approves them in a blocking
dialog at install time, and the grant is bound to the exact bytes installed — if
you ship new code, the user is asked again.

**Three permissions exist in v1:**

| Permission | Grants |
|---|---|
| `workspace.observe` | `api.workspace.observe` / `subscribe` |
| `sessions.observe` | `api.sessions.observe` / `subscribe` |
| `panes.observe` | `api.panes.observe` / `subscribe` |

Anything else fails the install with a message naming what this build supports.
Filesystem, transcript, git, prompt-sending and network capabilities **do not
exist** — they are not "not yet granted", they are unimplemented, and asking for
one is an install error rather than a silent no-op. Omit `permissions` entirely to
stay Tier 0, which installs with no prompt at all.

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

---

## 8. Developing locally

Cutting a GitHub release for every change is not a dev loop. Use **Load folder…**:

```
Settings → Extensions → Load folder… → pick your built folder
```

That takes a *snapshot copy* of the folder through the exact same validation as a
GitHub install. Rebuild, press **Reload** on the extension's row, and reopen your
view. Because the grant is bound to the installed bytes, a rebuild that changes
requested permissions asks for consent again.

---

## 9. Publishing

```bash
npm run build          # produces dist/index.js
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
| renders unstyled | CSS emitted as a sibling file instead of inlined |
| `fetch` fails | you have no network access — see §0 |
| a shortcut does nothing while your view has focus | expected; keystrokes do not leave the frame (§2) |

Failures appear in **Settings → Extensions**, on the extension's row, with the
message. A broken extension never prevents others from loading and cannot take
down the app.

---

## 11. What v1 deliberately does not have

Recorded so you know these are decisions, not oversights:

- **No background execution.** Activation events do not fire; your code runs while
  a view of yours is open (§1).
- **No network.** The frame's CSP permits only your own origin (§0).
- **No filesystem, transcript, git or prompt access.** Those are unimplemented, not
  merely ungranted (§6).
- **No marketplace.** The repo name is the trust decision.
- **No cross-extension communication.** Each extension is its own origin and cannot
  see another's frame, storage, or bundle.
