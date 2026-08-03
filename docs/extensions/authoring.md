# Writing an Agent Code extension

> **Status:** live. API version **1**.
>
> Reference implementation: [`Juliusolsson05/agent-code-timer`](https://github.com/Juliusolsson05/agent-code-timer).
> It exercises every part of this document — declarations, lazy activation, a
> view, persisted state, theming, and background work.

An extension is a **GitHub repository** containing a manifest and a built ES
module. Agent Code downloads it, validates it, and loads it at runtime. Nothing
is compiled into the app.

```
Settings → Extensions → owner/repo → Install
```

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

  "activationEvents": ["onStartupFinished"],

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
| `id` | `/^[a-z][a-z0-9-]{0,63}$/`. Becomes a directory name and your storage namespace. **Permanent** — renaming orphans user data. |
| `apiVersion` | Must match the host. v1 today; a host that implements only v1 refuses a v2 manifest with a message saying so. |
| `entry` | Relative path to a built ES module. No absolute paths, no `..`, no backslashes, must end `.js`/`.mjs`. |
| `contributes.*.id` | Must start with `<your id>.`. Enforced at install. |

### Why contributions are declared

The palette and Settings need to know what your extension offers **before it has
been loaded**. That is what makes lazy activation possible — a command can be
listed and invoked while your module has never been imported. Without
declarations, every installed extension would have to be imported at startup just
to populate a command list.

It also means a *broken* extension still shows what it contributes, with the
failure reason next to it, instead of silently vanishing.

### Activation events

| Event | Fires |
|---|---|
| `onCommand:<id>` | when one of your declared commands is invoked |
| `onView:<id>` | when one of your declared views is opened |
| `onStartupFinished` | once, after the window is interactive |
| `*` | immediately at startup — **avoid**; it makes every launch pay for you |

Use `onStartupFinished` only if you genuinely need to run without a window — a
timer that keeps counting, a watcher reacting to events. Otherwise prefer
`onCommand:`/`onView:` so you cost nothing until used.

---

## 2. The module

Your `entry` must export `activate`, and may export `deactivate`.

```ts
export function activate(context: ExtensionContext): void | Promise<void> {
  context.subscriptions.push(
    context.registerCommand('timer.start', () => { /* … */ }),
    context.registerView('timer.main', element => {
      element.textContent = 'hello'
      return () => { /* cleanup on close */ }
    }),
  )
}

export function deactivate(): void { /* optional */ }
```

- **`registerCommand`/`registerView` reject an id you did not declare.** A handler
  the palette has no entry for could never be invoked, so this fails loudly rather
  than leaving you with a dead command and no clue why.
- **Everything in `subscriptions` is disposed on deactivate**, in reverse order.
- **A view mount returns its own cleanup.** It runs when the view closes.

### Views are DOM-level

```ts
type ViewMount = (element: HTMLElement) => void | (() => void)
```

You get an empty element. Do whatever you like inside it. React is optional:

```tsx
import { createRoot } from 'react-dom/client'

context.registerView('timer.main', element => {
  const root = createRoot(element)
  root.render(<App />)
  return () => queueMicrotask(() => root.unmount())
})
```

This is DOM-level rather than "export a React component" for two reasons: it keeps
React optional (plain DOM, Preact, Svelte, canvas all work), and it is the one
shape that survives extensions later moving into an iframe — a component
reference cannot cross a frame boundary, but "call mount with this element" can.

---

## 3. React must come from the host

**You cannot bundle your own React.** Two React instances in one document means
two reconcilers, and every hook throws *invalid hook call*.

Agent Code publishes its runtime on `globalThis.__agentCodeHost`. Alias the
specifiers to shims that read it:

```ts
// vite.config.ts
resolve: {
  alias: [
    { find: /^react$/,               replacement: resolve(__dirname, 'src/host/react.ts') },
    { find: /^react\/jsx-runtime$/,  replacement: resolve(__dirname, 'src/host/jsx-runtime.ts') },
    { find: /^react-dom\/client$/,   replacement: resolve(__dirname, 'src/host/react-dom-client.ts') },
  ],
}
```

```ts
// src/host/react.ts
const react = globalThis.__agentCodeHost.react
export default react
export const { useState, useEffect, useRef, useMemo, useCallback /* … */ } = react
```

Copy these four files from
[agent-code-timer/src/host/](https://github.com/Juliusolsson05/agent-code-timer/tree/main/src/host).

**Why aliasing and not `external: ['react']`:** marking it external leaves a bare
`react` specifier in the output, and a browser cannot resolve a bare specifier
without an import map — which would have to be declared by the host before its own
first module loads. Aliasing resolves it at *your* build time and needs nothing
from the host beyond the global. Any dependency that imports react
(framer-motion does) gets the alias for free.

---

## 4. Build output

Two hard requirements:

1. **A single ES module** at the manifest's `entry` path.
2. **Committed to the repository.** The installer downloads your repo's source
   tarball, not a release asset, so a `dist/` that only exists in CI means every
   install fails with *"manifest points at a file that does not exist"*.

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

**Vite's library mode does not replace `process.env.NODE_ENV`.** A normal app
build does; a library is expected to leave it for the consuming bundler. There is
no consuming bundler here — your output is loaded straight into a renderer with
`nodeIntegration: false`, where `process` does not exist.

Nearly every React-ecosystem package guards its dev warnings with
`process.env.NODE_ENV !== "production"`, so the first one to execute throws and
your extension fails during `activate()` — **after** installing and importing
cleanly, which makes it look like your code rather than your build.

The `define` above is the fix. Do **not** shim a global `process` object instead:
libraries would then take Node code paths inside a browser realm, which fails
later and far less obviously.

The reference timer hit this on its first real run. framer-motion ships eight of
those guards.

**CSS must be inlined by your bundle**, not emitted as a sibling file. Vite's
library mode emits `style.css` regardless of `cssCodeSplit`, and the host fetches
exactly one file — a stylesheet nothing requests silently never applies. Import
it `?inline` and inject a `<style>` tag yourself.

---

## 5. The API

Your `context.api` is `AgentCodeApiV1`. **Every method returns a Promise**, with
no exceptions — a future transport cannot be made synchronous, and widening a
signature later would touch every call site in every extension.

```ts
api.extension.id                     // your id
api.storage.get/set/delete/keys      // your own namespace, persisted
api.ui.close()                       // close your view
api.ui.showToast(message)            // app-wide toast
api.theme.tokens()                   // resolved --theme-* values
```

That is the whole of API v1 — **Tier 0**, everything an extension may have
without asking. Workspace, session, transcript, git, filesystem and network
access are Tiers 1–3: they need a capability model and a consent flow that do not
exist yet, and guessing their contracts before a real consumer needs them would
be worse than adding them late.

### Storage notes

- Namespaced by extension id; you cannot read another extension's data.
- Values must be JSON-serializable. **`NaN` and `Infinity` are rejected** rather
  than silently stored as `null`.
- Concurrent writes are serialized, so `void set('a',1); void set('b',2)` is safe.
- **Survives uninstall.** Uninstall-then-reinstall is a normal troubleshooting
  move; destroying user data as a side effect of it would be hostile.

---

## 6. Theming

Agent Code exposes its palette as `--theme-*` custom properties. Use them in CSS
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

Prefer CSS over `api.theme.tokens()` — it cascades for free and keeps working
across a frame boundary. The accessor exists for imperative consumers (canvas,
computed SVG fills).

**Only the `--theme-*` layer is contract.** The `--color-*` Tailwind bindings are
an implementation detail of how the app wires its utilities; depending on them
couples you to the host's build system.

---

## 7. Publishing

```bash
npm run build          # produces dist/index.js
git add dist && git commit
git tag v0.1.0 && git push --tags
gh release create v0.1.0
```

Agent Code prefers **the latest release tag** and falls back to the default
branch — a release is the author saying *this is ready*, whereas a branch is
whatever was pushed thirty seconds ago.

The installer records the resolved ref and a **SHA-256 of the tarball**, so
"which bytes am I running" stays answerable.

---

## 8. Failure modes you will hit

| Symptom | Cause |
|---|---|
| *"Repository has no agent-code.extension.json"* | manifest missing, or not at the repo root |
| *"manifest points at a file that does not exist"* | `dist/` not committed |
| *"registerCommand(x) — not declared"* | id missing from `contributes.commands` |
| *"entry module does not export an activate(context) function"* | wrong export, or the bundle is not an ES module |
| *"process is not defined"* | missing `define: { 'process.env.NODE_ENV': … }` — see §4 |
| *invalid hook call* | you bundled React instead of aliasing to the host |
| renders unstyled | CSS emitted as a sibling file instead of inlined |
| *"targets Agent Code API v2, this build implements v1"* | Agent Code is older than your extension |

Failures appear in **Settings → Extensions**, on the extension's row, with the
message. A broken extension never prevents others from loading and cannot take
down the app.

---

## 9. What v1 deliberately does not have

Recorded so you know these are decisions, not oversights:

- **No agent/session access.** Reading transcripts or sending prompts is Tier 1–3
  and needs enforceable per-extension identity, which same-realm loading cannot
  provide.
- **No process isolation.** An extension shares the renderer. An infinite loop in
  your code hangs the app. The threat model here is *"I made a mistake"*, not
  *"someone is attacking me"* — extensions come from repositories you chose. That
  changes if extensions ever come from strangers, and the DOM-level view contract
  is what keeps the iframe door open.
- **No marketplace.** The repo name is the trust decision.
- **`mount: 'modal'` only.** `panel` and `tab` are the same registration with a
  different host shell.
