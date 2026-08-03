# Extension Platform — Investigation Findings

> **Status:** live. This is the *evidence* the design will be argued from, not the design.
> The architecture decision is deliberately **still open** at the bottom of this file —
> four consultants are being run against it. The plan file lands after they report.

**Date:** 2026-07-20
**Branch:** `feat/extension-platform`

---

## 1. What is being built, in the user's words

Personal workflow tools that live inside Agent Code — *not* product features, *not* MCP
tools for the agent to call.

- Installed and managed **from Settings**, sourced from GitHub.
- Invoked by a palette command (`Open Timer`).
- Opens **"a VS Code like custom page"** for that extension.
- Backed by an API with **access to a lot of app features** — the reference example (a
  timer) needs almost none of it, but "app-integrated extensions" are the point.

The timer is the forcing function, not the goal. The goal is a platform where the user
(and later others) can add workflow tools without touching core app source.

---

## 2. The single most important finding

**Agent Code already ships an extension host.** `packages/workflow-mcp` executes
user-authored JavaScript in production today, with every hard problem already solved:

| Extension-host problem | Where it is already solved |
|---|---|
| Discover user code on disk | user-level + project-level workflow dirs |
| Read metadata without executing it | `acorn` parses the `meta` export as a pure AST literal |
| Integrity | SHA-256 of source bytes; 512 KB size cap |
| Consent | Electron dialog keyed to `canonicalIdentity + sourceHash` (`WorkflowSourceApprovalStore`) |
| Sandbox | `node:vm`, null-prototype global, `codeGeneration: { strings: false, wasm: false }` |
| Determinism | `Date.now()` / `Math.random()` removed from the realm |
| Process isolation | separate Electron `utilityProcess` — *"Agent Code Workflow Evaluator"* |
| Lifecycle | heartbeats, timeouts, cancel, kill |

**Implication:** the question was never "how do we host user code." That is done. The
only open question is **how user-authored UI reaches the screen.**

What workflow-mcp does *not* have: any UI contribution story at all.

---

## 3. Renderer constraints (verified, with evidence)

### 3.1 Content-Security-Policy

`src/renderer/index.html:15-18` — the app's only CSP:

```
default-src 'self';
img-src 'self' data: blob:;
style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src 'self' data: https://fonts.gstatic.com;
script-src 'self';
worker-src 'self' blob:
```

- No `'unsafe-eval'`, no `blob:` for scripts → the "read source text and evaluate it"
  family of workarounds is closed.
- `worker-src 'self' blob:` was tuned **deliberately** (the inline comment cites #513 —
  Monaco's blob workers were dying silently). This policy is load-bearing, not incidental.
- `src/remote-client/index.html` has **no** CSP at all — a second renderer surface that
  any UI contribution model has to account for.

**Correction worth recording:** one investigation agent reported "no CSP is set anywhere"
— a grep miss that did not cover `.html`. That conclusion was wrong and its downstream
reasoning ("no browser-level containment to build on") must not be reused.

### 3.2 Document origin differs between dev and prod

`src/main/window/mainWindow.ts:424-428`

```ts
if (process.env['ELECTRON_RENDERER_URL']) {
  mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])   // dev: http://localhost
} else {
  mainWindow.loadFile(join(__dirname, '../renderer/index.html'))  // prod: file://
}
```

A design that works in one mode and not the other is the trap here. A `file://` import of
a home-directory bundle plausibly passes in prod and is double-blocked in dev. **Any
loading scheme must be identical in both modes** — which a custom protocol satisfies and
a raw filesystem path does not.

### 3.3 Window hardening

`src/main/window/mainWindow.ts:334-336` — `sandbox: false`, `contextIsolation: true`,
`nodeIntegration: false`. Renderer-hosted code gets no Node, no `require`, no fs. This is
correct and should not change.

### 3.4 Everything in the UI layer is statically registered

| Registry | Shape | Evidence |
|---|---|---|
| Surfaces | 3 module-scope `const` arrays, 25 static imports | `app/surfaces/registry.tsx:41,:87,:92` |
| Commands | one `const commandDefs` from 14 imported arrays (~95 defs) | `features/command-palette/registry.ts:26` |
| Pane kinds | exhaustive `Record<AgentProviderKind, …>` that `throw`s on unknown | `providers/registry.renderer.ts:53` |
| Keybinds | one hardcoded capture-phase `document` listener | `workspace/tile-tree/useKeybinds.ts:897` |

There is **no add/remove/register function anywhere** in the renderer UI layer.

The *consumption* side is already generic, though — `GlobalModals` / `GlobalOverlays` /
`SidePanels` just `.map()` an array, and `buildCommandRegistry` is recomputed per context
change. A second array concatenated into each map is a small change.

### 3.5 A "page" cannot be a split pane

`workspace/types.ts:38-39` — `TileNode` leaves are `{ type: 'leaf'; sessionId }`. Content
dispatch runs through a closed `SessionKind` union that throws on unknown ids.

Custom UI therefore mounts as **modal / overlay / side-panel**, not as a tile, unless a new
non-session `TileNode` variant is added — which touches treeOps, geometry, persistence and
keybinds. Out of scope for v1.

### 3.6 Two integration contracts that do not cross a frame boundary

This is the finding that most threatens the iframe design:

- **Interaction ownership is a DOM attribute query** —
  `lib/interaction-ownership.ts:22-36` reads `data-agent-code-interaction-owner="app"`
  from the DOM.
- **Paint order is DOM sibling index** — `app/surfaces/registry.tsx:33-38,:44-59`
  documents that array position *is* z-order, and that a prior PR (#505) shipped a
  stacking regression by grouping semantically instead of by paint order.

An iframed surface participates in neither. It would need theme tokens piped over
`postMessage` to avoid looking foreign, and would fight the keyboard system rather than
join it.

Also relevant: there is currently **zero** `<iframe>` / `<webview>` / `BrowserView` /
`WebContentsView` anywhere in `src/`, and `shared/performance/types.ts:147` treats their
appearance as an *anomaly* in the perf baseline.

---

## 4. Main-process / API constraints

### 4.1 `window.api` cannot be handed to an extension

`src/preload/index.ts:23` exposes exactly one global, built by flattening 27 per-domain
modules into a single flat object — roughly **153 methods**, no namespacing, including
`spawnSession`, `killSession`, `editor-fs:*` writes and `git:*`. Name collisions are
caught only by TypeScript at compile time (`preload/api/index.ts:38-42`), a guarantee that
means nothing for out-of-tree code.

There is **no IPC channel allowlist, no sender validation, and effectively no argument
validation** on the desktop path (~130 raw `ipcMain.handle('<literal>', …)` registrations,
zero `validateSender` hits).

**Therefore:** extensions must get a separate, narrow, schema-validated bridge — never a
filtered view of `window.api`.

### 4.2 Prior art for capability boundaries already exists

Two real precedents, and they are the templates:

- `EditorFsRootRegistry` — per-`WebContents` filesystem root grants. *The extension may
  name a path, but the name is not authority.*
- `src/main/remote/protocol/messages.ts` — a zod discriminated union where **the union is
  the allow-list**. Unrepresentable rather than denied.

### 4.3 Persistence has a landmine

Renderer settings live in one zustand-persist `localStorage` key with a manually bumped
version. `app-state/store.ts:35-57` documents that forgetting the bump **shipped a
black-screen launch bug twice** (#249).

**Therefore:** extension settings must not go in the `Settings` store. Use main-owned
state under `STATE_DIR` plus the existing self-subscribing settings-row marker pattern
(`cli-update-behavior` / `dictation-api-key` are the precedents).

### 4.4 No runtime capability registry

`src/mcp/shared/types.ts:1-15` — MCP domains are a closed TypeScript union
(`'ping' | 'orchestration' | 'ai_workspace' | 'agent_transcripts' | 'workflows'`), gated by
five hand-written `if` blocks. An extension-contributed capability cannot be *expressed*
today without introducing a runtime registry keyed by string id.

---

## 5. Distribution precedent

Two existing models in-repo:

- **`third_party/<tool>/manifest.json`** — pinned version + per-arch sha256 + URL template;
  binaries never committed; a fetch script verifies the hash before use. **This is directly
  reusable as an extension distribution model.**
- **`packages/*`** — git submodules consumed as `file:` deps with build-time Vite aliases.
  **Not** a packaging model: there is no artifact resolution, version negotiation, or
  integrity check anywhere for `packages/*`.

Install should use a **release tarball, not `git clone`** — `git` is `required: false` and
`src/main/ipc/git.ts:115-118` launders its failures into `''` (issue #495/A5).

---

## 6. Theming — the one part that is unambiguously easy

`src/renderer/src/styles.css` defines a two-layer token system:

```css
:root, [data-mode="dark"] {
  --theme-canvas: #0a0a0a;
  --theme-surface: #111113;
  --theme-ink: #e8e8e6;
  /* … */
}

@theme inline {                              /* Tailwind binding */
  --color-surface: var(--theme-surface);
}
```

The `--theme-*` layer is exactly the shape VS Code exposes to webviews as `--vscode-*`.
Whatever hosting model wins, extensions consume these token names and re-theme live when
the host re-pushes on mode/accent/font change.

---

## 7. Environment note

`package.json` declares `electron: ^43.1.0`; `package-lock.json` pins **43.1.1**; CI runs
`npm ci --include=dev` on Node 24 and has been green on `main` since the bump landed
2026-07-12 (`23205144`).

The local `node_modules` in this checkout is stale at **31.7.7** — an install artifact, not
a real version disagreement. Any spike touching `protocol.handle`, custom schemes, or
iframes **must** run against 43.1.1 or its result is meaningless. Fix with `nvm use` +
`unset NODE_ENV` + `npm ci --include=dev`, and note that `node_modules` is shared by ~30
worktrees via symlink.

---

## 8. The open architecture decision

Hosting is solved (§2). Everything below is about **how extension UI reaches the screen**,
and it is genuinely unresolved. Estimates are from the read-only investigation and have not
been validated by a spike.

### Option A — compiled-in apps folder (`src/apps/<id>/`)
An app is a repo directory exporting a definition object; one generic host surface, one
generic `openAppId` field, one command module that maps the app list. Adding an app is one
import plus one array entry.

- **Effort:** 1–2 days host, ~half a day for the timer.
- **Unlocks:** full React, full store access, full type safety, native theming, zero new
  security surface.
- **Costs:** rebuild to add or update an app. **Does not satisfy "install from Settings."**

### Option B — runtime-loaded JS bundle
Extension bundle in `~/.config/agent-code/extensions/<id>/`, loaded into the renderer via a
privileged custom scheme.

- **Effort:** 2–4 weeks, *"and it never really finishes."*
- **Blocker named by the synthesis:** a **stable injected host ABI**. Extension code cannot
  `import react` (two copies ⇒ broken hooks) and cannot import app modules
  (`electron-builder.yml` strips `!src/**`; chunks are content-hashed —
  `./assets/index-BK1aliEx.js` rotates every build). Every host object must be *passed in*,
  which means designing and versioning that object before the first extension exists.
- **Less hard than folklore:** the renderer emits native ESM with no `output.format`
  override, so `import(variable)` survives Rollup. Bundling is the weakest constraint here,
  not the strongest.

### Option C — iframe on a custom scheme or local origin
Extension owns its own document, own origin, own CSP.

- **Effort:** 1.5–3 weeks.
- **Unlocks:** true isolation, arbitrary pixels, any framework, no host `script-src` change
  (an iframe needs `frame-src`, since CSP is per-document).
- **Costs:** §3.6 — interaction ownership and paint order are DOM-level contracts that do
  not cross a frame boundary. Plus a postMessage RPC layer, a per-frame CSP, and a perf
  baseline update. `RemoteServer` + `src/remote-client` prove the "second built surface over
  local HTTP" half already works.

### The question the consultants must answer

> The user wants (a) install-from-Settings, (b) a custom page, and (c) a broad app API.
> Option A satisfies (b) and (c) in 1–2 days but fails (a). Options B and C satisfy (a) at
> 10–20× the cost, and C specifically trades away the two DOM-level contracts that make a
> surface feel native.
>
> **Is there a staging that delivers a working timer fast without building a substrate the
> real answer has to tear out?**

---

## 9. Deliberately not decided here

- Whether v1 is desktop-only (`src/remote-client` is a second renderer build).
- Whether extensions ever get a tile/pane mount, or stay modal/panel/overlay forever.
- Relationship to issue **#244** (host user-authored *MCP servers* as extensions). That
  issue gives extensions **agent** capabilities; this work gives them **app** capabilities.
  Sibling systems or one system is an open call.
- Whether `components/ui/README.md`'s "no surface factories" guardrail is contradicted by
  this work. If a design lands that looks like a surface factory, that README must be
  updated in the same PR with the reasoning — not quietly bypassed.
