# Full Extension Platform — Complete Build Plan

**Status:** specification (no code) · **Branch:** `feat/extension-platform` (PR #577) · **Date:** 2026-07-22
**Base:** the `origin/main` merge `68c1b34a` (178 commits) + piece-1 wiring `c42a47a1`.

## Decisions locked (2026-07-22)

The §9 open questions were resolved by the maintainer:

1. **Iframe fork → Option A** (plain `<iframe>` + `MessagePortMain`). Not Option B.
2. **Keybinding conflict → accept-and-report at load.** Both extensions install; the clash
   is reported; first-party wins.
3. **Settings placement → a per-extension section** under an "Extensions" category, so
   uninstall removes a clean block.
4. **Uninstall → preserve** setting values + keybind overrides for reinstall.
5. **Custom feed / tool renderers → CUT.** Extensions may ship an MCP tool, but its output
   renders through the **standard MCP rendering** (the generic `ToolResultRow` fallback the
   app already applies to any MCP tool). No extension-authored feed rows. WHY: a custom
   renderer would put third-party synchronous React into the feed — the most trusted surface
   — and the feed rendering pipeline has been a repeated problem area (the renderer rewrite,
   provider plug-and-play #394). The safety cost is not worth the differentiation. This
   removes the hardest, most dangerous piece of WS7 entirely.
6. **SDK → a separate submodule repo**, matching the other `packages/*`.

## 0. How to read this, and where it comes from

This is the exhaustive build specification for turning the extension platform from a
working *app-in-a-modal* demo into a *VS Code-grade contribution system*. It is written
for the engineer who implements it, so it carries every constraint, invariant, file:line
anchor, and decision — not a summary.

**Provenance.** It synthesizes nine independent research passes over the merged tree
(three surface/API/service maps plus six deep spec passes: sandbox, capability, keybind/
settings wiring, pane model, advanced registries, lifecycle/SDK). Every file:line below
is relative to this branch *after* the merge; re-grep after any further rebase.

**Relationship to the other docs in this folder:**

- `2026-07-20-extension-platform-investigation.md` — **superseded / stale.** Its findings
  reasoning still holds, but its snapshot drifted with the 178-commit merge: the CSP block
  it quotes (its §3.1) predates `agent-code-ext:` being added to CSP (now at
  `src/renderer/index.html:28`); its "~153 methods / 27 modules" undercounts (30 modules
  now); and its central §8 "architecture decision A/B/C is open" is **answered** — option B
  (runtime bundle over the `agent-code-ext://` scheme) shipped. Do not treat it as
  current-state.
- `2026-07-20-extension-platform.md` — the original full plan. **This doc aligns with and
  extends it**, re-anchored to the merged tree. Its Phase D (Tiers 1-3, iframe) is the
  spine of workstreams 4-7 here.
- `2026-07-20-extension-platform-stage1.md` — superseded by its own header; kept for §0-§3
  reasoning. Its Task 5/6 (palette commands, Settings row) targeted the *old* palette and
  are obsolete after the merge.
- `2026-07-22-extension-contributions-into-merged-systems.md` — the active near-term
  plan; **workstreams 1-3 here are its three pieces**, expanded to spec-completeness with
  the deep-pass findings (notably the keybind-editor correction in WS2).

## 1. Goal and the parity target

Let user-authored extensions, installed from a GitHub repo, integrate as first-class
citizens of the app: contribute **commands, keybindings, settings, views, grid/dispatch
panes, and themes**, and — behind consent — reach app **services**
(workspace, sessions, filesystem, network). The bar is VS Code: declarative `contributes`
+ lazy `activate`/`deactivate` + a capability/consent model + process-level isolation.

**The VS Code mental model, mapped to this app.** Commands are the universal invocation
currency: a keybinding, a palette entry, a menu item, and a button all resolve one command
*id*, never bind to code directly. Contribution points are declarative in the manifest and
wired host-side; only *live UI* and *service calls* need the extension's running code. That
split is the organizing principle of this whole plan.

## 2. The organizing principle: the declarative / imperative fault line

Every capability an extension could want falls on one side of a single line, and that line
decides sequencing and risk:

- **Declarative / data contributions** — commands, keybindings, settings, themes, menu
  entries. These are populated host-side *from the manifest alone*; no extension code runs
  at registration time. **They open cleanly now, with no sandbox.** (Research pass 6 & 8
  confirm the manifest already validates all of them; three are still dead consumers.)

- **Imperative + synchronous-React contributions** — a view mounted into a modal/pane, a
  contributed surface. These render the extension's own React/
  DOM *synchronously into the host tree* and/or call app services at runtime. **These
  require the iframe sandbox** — because a same-realm extension already reaches
  `window.api`'s ~153 methods directly (`ExtensionHost.ts:87-88`), so any capability gate
  on them is advisory until each extension has a distinct frame identity.

Contributed surfaces need "a React component rendered synchronously into the host tree,"
which collides head-on with the ABI's all-async, no-`@renderer/*`, frame-boundary rule
(`apps/api/types.ts:9-41`). That collision is the sandbox, and it is the gate for the
powerful half of the platform. (Custom *feed* renderers were the sharpest version of this
collision; they are **cut** — Decision 5 — so extension tool output uses standard MCP
rendering and never returns third-party React into the feed.)

**Consequence for the roadmap:** build every declarative contribution first (WS1-3), then
the sandbox (WS4) and its capability model (WS5), then the imperative surfaces that depend
on it (WS6-7), with the SDK/versioning (WS8) threaded alongside.

## 3. Current state — verified

The manifest schema (`src/main/extensions/manifest.ts:131-148`) already validates every
contribution type. What is actually *consumed*:

| Contribution | Schema | Wired today | Evidence |
| --- | --- | --- | --- |
| `commands` | `manifest.ts:65` | **YES** (palette) + **partial** (Settings) | `CommandPalette.tsx:808/813` passes `deriveExtensionCommands` into `buildCommandRegistry`; piece-1 `c42a47a1` threads them into the Settings "Commands" *visibility* list via `getSettingsRegistry(extensionCommands)` → `listPickerCommandMeta(extensionCommands)` (`settingsRegistry.ts:394`). **But NOT the keybind editor** — see WS2. |
| `views` | `manifest.ts:72` | **partial** — `mount: z.enum(['modal'])` only | Modal host works (`AppHostSurface.tsx`). `'panel'`/`'tab'` reserved (`manifest.ts:75-78`). |
| `keybindings` | `manifest.ts:108` | **NO — dead** | Validated (`manifest.ts:229-237`), zero consumers. No `deriveExtensionKeybindings`. |
| `settings` | `manifest.ts:82` | **NO — dead** | Validated, zero consumers. No `deriveExtensionSettings`, no `SettingDefinition` produced. |

The runtime host (load/activate/deactivate/failure capture) is real and good: `ExtensionHost.ts`,
`ExtensionHostProvider.tsx`, `viewBridge.tsx`. Install/update/ledger is real:
`install.ts`, `ledger.ts`. What is missing is (a) three declarative consumers, (b) the
sandbox, (c) the capability model, (d) the pane host shell, (e) the SDK.

## 4. The architecture spine

### 4a. Commands are the currency
Palette, native menu, keybinding, and programmatic callers all funnel through one gateway,
`dispatchCommand` (`executeCommand.ts:131`), resolving a command *id*. Extension commands
already flow into the palette. Everything id-keyed (keybindings, menu entries) hangs off
this. This is the VS Code model and it is already the app's model — build on it, don't
reinvent it.

### 4b. The ONE registry pattern to standardize on
For every *open* contribution surface (unknown, third-party key set), copy the
**condition-view registry idiom** — the only pattern in the codebase already built for open
contribution (research pass 5):

- `defineView<K,S>({...})` authoring helper that infers types from the literal
  (`src/shared/conditions-core/view.ts:67-71`).
- An **open** `Record<string, Contribution>` — never `Record<ClosedUnion, FatBag>`.
- A **single generic host** that does `const c = registry[key]; if (!c) continue;` — routes
  by key, **skips unknown keys**, never throws (`ConditionOutlet.tsx:57-73`). Contrast the
  provider registries, which `throw` on unknown (`registry.renderer.capabilities.ts:333`) —
  correct for a closed first-party set, fatal for third-party contribution.
- **One audited erasure seam** (`eraseRegistry`, `view.ts:139-143`) converting precise
  contributor types to the host's erased type, sound because the host only routes by key.
- A **namespacing guard** at admission (`CONTRIBUTION_ID` already enforces
  `<extensionId>.<name>`, `manifest.ts:60-68`).

Where semantics are *ordered probe* rather than exact-key (feed/tool renderers, formatters),
keep the keyed-registration ergonomics but consume via the `COMMAND_FORMATTERS`
first-non-decline-wins loop (`formatters/index.ts:39-43`), with extension entries assembled
at runtime and ordered **last** (exactly as `deriveExtensionCommands` already appends).

### 4c. The isolation decision — the crux, and it is a fork
An extension today `await import('agent-code-ext://…')`s **into the renderer's own realm**
(`ExtensionHost.ts:87-88`) — same WebContents, same `window`, full `window.api` in reach.
Every guard is a mistake-guard, not an attacker-guard (`hostGlobal.ts:38-42`,
`ipc/extensions.ts:14-30`). Real isolation requires each extension in its own frame so the
host can derive identity from the sender. **The fork (research pass 1):**

- **Option A — plain `<iframe src="agent-code-ext://…">` + postMessage.** Own origin, own
  CSP, true isolation; **no preload** (a same-process iframe shares the parent's), so the
  host talks to it *only* over `window.postMessage`/`MessagePortMain`. The entire
  `AgentCodeApiV1` "everything is a Promise" discipline (`types.ts:20-28`) was built for
  exactly this transport.
- **Option B — `WebContentsView`/`<webview>`.** Own WebContents → own preload + own session
  partition (strongest identity via `webContents.id`), but heavier, and it reintroduces the
  native-surface paint/z-order mismatch that killed the overlay window (#518).

**Recommendation: Option A (plain iframe + `MessagePortMain`).** It matches the pre-built
all-async ABI, gives a real origin + per-document CSP, and `event.senderFrame`/a per-frame
`MessagePortMain` yields unforgeable identity without a second WebContents. Reserve Option B
only if a capability genuinely needs a preload-level Node bridge. This is the one decision
that is expensive to reverse — see §9.

## 5. Workstreams

Each: goal, files (file:line), the contract to define, constraints, gotchas, done-when,
rough effort. Effort assumes one focused engineer; parallelizable where noted.

### WS0 — Foundations: rebase (done) + the three #577 bugs + ledger hardening
**Goal:** land the merged branch clean and fix the known defects before building on them.

1. **Rebase** — DONE (`68c1b34a`), both tsc projects green.
2. **Update-button no-op** — `AppsSettingsRow.tsx:179-182`. `onClick` does
   `setRepo(entry.repo); void install()`, but `install` (`:54`, `useCallback` deps
   `[repo,busy,refresh]`) reads the *previous* `repo` (async `setState`), so it early-returns
   or installs the wrong repo. **Fix:** `install(target?: string)` defaulting to `repo`;
   Update calls `install(entry.repo)` directly.
3. **Uninstall never deactivates** — verified: `AppsSettingsRow.remove` (`:80-94`) calls
   `window.api.extensionsRemove` + `refresh()` and holds **no** `ExtensionHost` reference;
   main has no handle on the renderer host; `grep '\.deactivate'` shows only
   `deactivateAll` on provider unmount. So a removed extension's intervals/listeners/
   registrations leak for the session. **Fix:** `remove` (and the Update path) must call
   `useExtensionHost().deactivate(entry.manifest.id)` before/after the IPC. **Must be in the
   renderer** — main cannot reach the host.
4. **Ledger cast** — `ledger.ts:30` `return parsed as InstalledExtension[]` (no per-row
   validation) flows unchecked into the `import()` URL and the palette. Deliberately
   tolerated, but a legitimate hardening item: validate rows with a zod mirror of
   `InstalledExtension`, drop malformed rows individually (not the whole ledger).

**Constraint:** the #577 triple is already assigned "alongside piece 1" by the 2026-07-22
plan (`:199-200`). **Effort:** ~1 day.

### WS1 — Command spine (finish it)
**Goal:** extension commands fully first-class in every command surface.

Piece 1 (`c42a47a1`) wired them into the palette and the Settings *visibility* row. **The
gap (research pass 3, correcting the piece-1 commit message):** the keybind editor
`CommandKeybindingsRow` iterates `builtInCommandCatalog` **directly** (`:121`), takes **no
props** (`:92`, rendered `<CommandKeybindingsRow />` at `SettingsList.tsx:234`), and never
sees extension commands. It also filters by `command.category` (`:124`) grouped by an
**exhaustive** `Record<CommandCategory, number>` (`:59-71`), and `deriveExtensionCommands`
sets **no category** (`derive.ts:84-108`) — so extension commands would be filtered out even
if listed.

**Do:** give `CommandKeybindingsRow` the derived extension commands as props (from
`SettingsPage`, which already computes them at `:69-75`); iterate catalog **plus** those;
assign extension commands a category — a new `'extensions'` `CommandCategory` member (add to
the union `types.ts:51` + `CATEGORY_LABELS`/`CATEGORY_RANK`) or a bucket in derivation.
Capture/conflict-UI/commit are keyed by command-id string and work unchanged.

**Done when:** an extension command appears in the keybind editor and can be bound.
**Effort:** ~2-3 days. **No sandbox.**

### WS2 — Keybindings (`contributes.keybindings` → the resolver)
**Goal:** an extension's declared chord fires and shows in the editor.

**The system (research pass 3):** `CommandBindingDefault = {commandId, bindings, context}`
(`defaults.ts:55-59`); `buildDefaultKeybindings()` (`:77-283`) is the shipped table;
`resolveEffectiveKeybindings(overrides, defaults, contextForCommand)` (`resolve.ts:93-143`)
resolves id→chord with user overrides winning; `coerceCommandKeybindingOverrides` **already
preserves unknown ids** "for an extension temporarily uninstalled" (`resolve.ts:29-38`);
storage is the Settings blob key `commandKeybindingOverrides` (**not** a `~/.claude` file);
firing is `useKeybinds.ts` → `pendingCommandInvocation` → `dispatchCommand`.

**The insertion point:** an extension binding is a **default**, concatenated onto
`buildDefaultKeybindings()`'s output. It must be threaded at **all three** call sites, or it
half-works:
1. `useKeybinds.ts:243` (`buildBindingIndex`) — hardcodes `buildDefaultKeybindings()`.
   Without this, **the chord never fires.** The hook must also subscribe to
   `installedExtensions`.
2. `registry.ts:183` (`buildCommandRegistry`) — calls `resolveEffectiveKeybindings(...)`
   with no `defaults` arg. Without this, the palette row shows no shipped chord.
3. `CommandKeybindingsRow.tsx:101/105/115` — the editor. Without this, no default/conflict.

**The derivation:** new `deriveExtensionKeybindings(installed): CommandBindingDefault[]` in
`derive.ts` (mirroring `deriveExtensionCommands`). Per contributed `{command, key}`:
`{ commandId: binding.command, bindings: [tryNormalizeKeybinding(binding.key)].filter(Boolean),
context: 'global' }`. **Key-format gotcha:** the manifest `key` is freeform
`z.string().max(64)` (`manifest.ts:110`) but the resolver needs the canonical `Keybinding`
form (fixed modifier order `Cmd,Ctrl,Alt,Shift`, `normalize.ts:40`). Use
`tryNormalizeKeybinding` (returns `null`, `normalize.ts:181-188`) at the boundary so one bad
manifest key doesn't throw the whole table. `context: 'global'` is strictest for collision
(overlaps every context), erring toward reporting conflicts.

**Conflict policy:** run each chord through `findBindingOwners({binding, context:'global',
commandDefaults, dictationBinding, excludeCommandId})` (`reservations.ts:356-387`).
Non-empty = collision. **Accept-and-report at load** (like cross-extension command-id
collisions, `derive.ts:16-18`), not reject-at-install — an extension can't see another's
manifest. `ExtensionKeybindingContribution` already documents "Consulted AFTER every
first-party binding, so an extension can never shadow ⌘W" (`extensions.ts:37-39`): on
collision the first-party owner wins, the extension chord is dropped and reported.

**Done when:** an extension shipping `{command,key}` fires the key, the editor shows it, a
conflict is surfaced not silently dropped. **Effort:** ~3-5 days. **No sandbox.**

### WS3 — Settings rows (`contributes.settings` → the registry)
**Goal:** an extension's declared settings render as real rows and persist.

**The hard rule (#249):** the app's `Settings` is one flat zustand-persist blob; a forgotten
persist-version bump black-screened launch twice (`settingsRegistry.ts:962-975` states it
verbatim). Extensions are authored outside the release cycle, so **extension setting values
must never enter the Settings blob.**

**The shape:** add an `'extension'` **marker** variant to the `SettingDefinition`
discriminated union (`settingsRegistry.ts:92-287`), beside the existing `'apps'` marker,
rendered by a new self-subscribing component in `SettingsList.tsx` (mirroring the
`'command-keybindings' ? <CommandKeybindingsRow/>` / `'apps' ? <AppsSettingsRow/>` dispatch
at `:234/:248`). The variant carries `{ type:'extension', extensionId, settingId,
valueType:'boolean'|'number'|'string', default }`. `boolean` → toggle; `number`/`string` →
inputs the generic union lacks (there is no free number/text control today).

**The value store:** per-extension storage keyed by contribution id — `window.api.
extensionStorageGet/Set(extensionId, key, value)` → `EXTENSION_STATE_DIR/<id>/state.json`
(`storage.ts:116-177`, non-finite numbers already rejected). The row is self-subscribing
(async read on mount, write-through on edit) exactly like `DictationApiKeyRow`. **Writes go
to extension storage, never `setSettings`** (which also re-runs `applyTheme` every write,
`slice.ts:29`).

**The derivation:** `deriveExtensionSettings(installed): SettingDefinition[]` in `derive.ts`,
concatenated into `getSettingsRegistry(...)` (`:396-988`); thread `installed` from
`SettingsPage` (already reads it). Category: reuse the existing `'apps'` category labeled
"Extensions" (`settingsCategories.ts:57-61`) or add a per-extension section (open question
§9). Uninstall cleanup: **preserve** values (mirror the keybind store's unknown-id
preservation; `ledger.ts:70-77` already keeps `EXTENSION_STATE_DIR` on uninstall).

**Done when:** an extension's `boolean`/`number`/`string` setting renders an editable row
whose value survives reload, stored under extension state. **Effort:** ~3-5 days. **No
sandbox.**

> WS1-3 together are the "no sandbox, high value" tranche and should be one coherent series.
> They also complete the still-outstanding Stage-1 acceptance test ("nobody has launched the
> app and clicked it") — do the manual run here.

### WS4 — The sandbox substrate (iframe + RPC + identity)
**Goal:** each extension's UI runs in a sandboxed iframe with the host holding all real
power; the extension asks over a validated message bus; the host derives identity from the
frame. This is the foundation the powerful half of the platform sits on.

**Already half-built (research pass 1):**
- `agent-code-ext://` scheme with all five privileges + realpath containment
  (`scheme.ts`), registered pre-`whenReady` (`index.ts:229`), handled at `:465`.
- CSP already whitelists `agent-code-ext:` in script/img/style/font/connect
  (`index.html:28`).
- `AgentCodeApiV1` all-async curated surface + `createAppHostApi` id-closure — the exact
  shape a per-frame facade should expose.
- `ViewMount` DOM-level contract + `viewBridge.tsx` isolated to one replaceable component.
- **The RPC template to copy verbatim:** the remote mobile protocol
  (`src/main/remote/protocol/messages.ts` + `scope.ts`) — a production zod-discriminated-
  union-as-allow-list with per-message auth and request/response correlation ids
  (`{token, id?, message}` → reply echoes `id`). "The schema IS the allow-list; out-of-scope
  operations are unrepresentable." This is the frame bus.

**Hard blockers to build:**
1. **No `frame-src` in host CSP**, and CSP is per-document — the child frame needs its own
   CSP header, which the scheme handler does not emit today (`scheme.ts`).
2. **The scheme serves modules, not an HTML document entry** — the manifest `entry` is a
   `.js`/`.mjs` (`ENTRY_PATH`, `manifest.ts:34-44`). Need a frame bootstrap HTML document +
   child-document CSP emission in the handler.
3. **Preload-per-frame requires a WebContents** — a plain iframe gets no preload
   (postMessage-only, Option A); `WebContentsView` gets one + a partition (Option B). This is
   the §4c fork.
4. **Single preload build, single session/partition, single window**
   (`mainWindow.ts:316-349`, `sandbox:false`, `contextIsolation:true`, `nodeIntegration:
   false`). Option A needs no second preload; Option B needs a second electron-vite preload
   entry + a partition model.
5. **DOM-level host contracts don't cross frames** — the interaction-ownership attribute
   (`lib/interaction-ownership.ts`), paint-order-by-sibling-index
   (`app/surfaces/registry.tsx`), the theme cascade, and the **entire keyboard system**
   (`useKeybinds.ts` single capture-phase listener — every host shortcut dies while focus is
   in a frame; Cmd+W would close the window) must be re-plumbed over postMessage. The prior
   plan prices this at **~350-650 LOC, keyboard routing being the bulk** (`2026-07-20-
   extension-platform.md:789-794`).

**Identity (research pass 2):** with a frame, `appId` stops being a caller argument and
becomes `deriveExtensionId(event.senderFrame.url)` (the hostname the scheme already keys on)
or the owning `MessagePortMain` (the cleanest — "the port IS the capability"). This converts
the storage namespace into a real authority boundary and is the precondition for every
Tier 1-3 capability.

**What `viewBridge.tsx` changes vs keeps (research pass 1):** the status machine, the
per-mount child div StrictMode fix, and error containment stay host-side. What changes:
`mount(element)` becomes "attach the iframe, postMessage `mount`, child runs `mount` on its
side"; the disposer becomes a postMessage + teardown; `getView` returns a *handle*, not a
live function; theme tokens must be **pushed** over postMessage since the cascade doesn't
cross. `hostGlobal.ts` (the React injection) becomes unnecessary in the frame model — the
child bundles its own React — a genuine simplification.

**Done when:** the timer extension renders in an iframe over `agent-code-ext://`, calls
`api.storage`/`api.ui` over the `MessagePortMain` bus, and the host derives its id from the
frame. **Effort:** ~2 weeks. The single hardest workstream. **Version note:** Electron 43 —
`event.senderFrame`, `MessageChannelMain`/`MessagePortMain`, `WebContentsView` all available.

### WS5 — Capability + consent model
**Goal:** an extension declares the powers it needs; the user grants them; the host enforces
per-call.

**Schema (research pass 2):** add a top-level `permissions` field to
`extensionManifestSchema` (a `z.enum` closed set narrowed by transform, exactly like
`activationEvent`, `manifest.ts:118-129`), so an unknown capability is *unrepresentable* at
install. The tier taxonomy is not invented — it is in `2026-07-20-extension-platform.md:781-
788`: Tier 1 `workspace.observe`/`sessions.observe`/`panes.observe`; Tier 2 `fs.read`/
`transcript.read`/`git.read`; Tier 3 `sessions.prompt`/`fs.write`/`git.commit`/
`network.fetch`.

**Mapping to real IPC (baseline: everything is trusted equally today):** `fs.read` →
`fs:list-directory` (`fs.ts:30`, unbounded now); `git.read` → `git:status` (`git.ts:522`);
`sessions.prompt` → `session:send-prompt` (`session.ts:98+`); the **one existing per-caller
gate** is `EditorFsRootRegistry` (`editorFsRootRegistry.ts:9-98`) — grants keyed by
`sender.id`, admit only if the named path canonically matches a live session cwd, revoked on
navigation. **This is the grant-registry template.**

**Consent flow:** install has zero consent today (`AppsSettingsRow.tsx:19-23` — "the repo
name IS the trust decision"), valid only while the API is Tier 0. A grant step inserts
between manifest parse and ledger write (`install.ts:218` has the manifest in hand before
the bundle moves at `:229`). **Template:** `WorkflowSourceApprovalStore.authorize(request,
prompt)` (`store.ts:35-61`) — grant bound to a **content hash**, not a name, so an update
that widens permissions re-prompts (install already computes the tarball sha256,
`install.ts:115`, stored in the ledger). Key the grant on `(extensionId, sha256,
capability)`. The renderer dialog uses the `closeConfirmationBroker` promise-broker pattern.

**Enforcement point:** the RPC router, dispatched by frame identity, gated per-capability
(coarse, per method-group). Three layers: (1) parse gate — the message round-trips the
allow-list union (unrepresentable = rejected); (2) grant gate — a per-frame grant registry
populated from the consent store; (3) apply-time state check where needed (e.g.
`sessions.prompt` validates against live entitlement, like the remote `pty` action).

**The forced sequencing:** Tier 1 (metadata) can ship *advisory* same-realm. Tier 2 needs
the consent store (buildable now). **Tier 3 enforcement is meaningless until WS4** gives
each extension a distinct sender — the schema, store, and registry can all be built first,
but the teeth only bite once identity is real. **Effort:** ~1 week (schema + store + registry)
+ enforcement that lands with WS4.

### WS6 — Extension-view panes (grid / dispatch)
**Goal:** an extension view mounts as a first-class pane, modeled on a terminal (durable
host-side session + thin renderer attach view). "Attach like a terminal list."

**The one render seam:** `renderWorkspaceLeaf` (`TileTree.tsx:96-171`) — the single switch
on `SessionMeta.kind` that grid, both dispatch layouts, spotlight, and tile-tabs all funnel
through. Add an `if (kind === 'extension-view')` short-circuit **before** the
`getRendererProvider(kind)` throw at `:130`, sibling to the terminal branch at `:118`,
returning `<ExtensionViewLeaf .../>`. This one edit lights up every mode.

**The type seam:** extend `SessionKind` (`providerKind.ts:47`) — an extension view is **not**
an `AgentProviderKind` (no transcript/resume/conditions/process), so add `'extension-view'`
alongside `'terminal'`. Every `Record<AgentProviderKind,…>` registry correctly excludes it
(and correctly throws if handed it — which is why the render short-circuit is mandatory).
Update the `Exclude<SessionKind,'terminal'>` agent-only signatures (`pane.ts:292,296,541,641`)
to also exclude `'extension-view'`, and audit `kind !== 'terminal'` agent guards toward
`isAgentProviderKind(kind)`.

**The session model — answer: (a) ride a real main-minted "extension-host session".** The
id-minted-by-main invariant (`types.ts:15-17`) is load-bearing across replace/bury/lane/pin/
recover; a renderer-minted id (option b) would force an "is this an extension leaf?" bypass
into every `ensureSessionLive`/rehydrate path — the scattered-conditional smell the codebase
fights. So: extend `SessionSpawnOptions.kind` to accept `'extension-view'` and add a spawn
branch in `sessionManager.ts` (sibling to terminal at `:515`/`:1161`) that mints an id and
registers a minimal `ExtensionHostSession` (no PTY, no provider) carrying `viewId`; `recover`
is a trivial re-register. `getMainProvider` is never called (returns before it, like
terminal).

**The terminal template made concrete:** the authoritative state (for terminal, PTY + rolling
buffer in main; for an extension, the mounted `ViewMount` DOM subtree in the renderer) is
durable; the leaf component is a disposable attach point keyed on `sessionId` only
(`TerminalLeaf.tsx:404`) so renderer churn never remounts it. **The extension case is harder
on one axis:** an xterm can be cheaply re-created from main's buffer, but re-running
`mount(element)` tears down and re-inits the extension (mount-once, `viewBridge.tsx:117-121`).
So the durable ViewMount DOM must survive remounts.

**The multi-mount / single-slot problem:** today `openAppId: string|null`
(`uiShell/types.ts:308`) permits one open app. A pane model needs N views addressed by
session id. Replace the single slot for the *pane* path (the modal path can keep `openAppId`)
with: (1) **address** via `SessionMeta.extensionViewId` (rides the existing per-session
metadata map, no new slice); (2) **durable mount** via a renderer-side ViewMount registry
keyed by `sessionId` that owns a detached DOM node per session — `ExtensionViewLeaf` adopts
the node on mount, re-detaches (not disposes) on unmount, the renderer analogue of main's
survive-across-remount buffer. Same-view-in-many-panes ships as N independent mounts first
(independent state), a shared-state mirror later — exactly parallel to the documented
terminal multi-attach caveat (`workspace/types.ts:266-280`).

**Manifest + derive:** add `'panel'` to `mount: z.enum([...])` (`manifest.ts:79`) and the
`shared/types/extensions.ts` mirror. `deriveAppDefinitions`/`deriveExtensionCommands`
(`derive.ts:21-113`) branch on `view.mount`: `modal` → current `openApp`/`AppHostSurface`;
`panel` → a command whose `run` spawns an extension-view session and splits it into the grid
(`workspace.spawnExtensionViewPane(view.id)`), not `openApp`. `viewComponentFor`
(`viewBridge.tsx`) is mount-agnostic — reused unchanged; only the host container differs (a
grid leaf div vs `DialogContent`). This is the payoff of the DOM-level `ViewMount` contract.

**Persistence + forward-compat:** an extension pane persists like any leaf (id in the
`TileNode` tree + `SessionMeta` in the flat map). `SessionMeta` gains
`extensionViewId: string` (the durable mount identity, analogous to a terminal's `tmuxName`).
`rehydrate.ts:615-632` — once `'extension-view'` is a known `SessionKind` it is no longer
caught by the unknown-kind guard, so add an explicit branch: **installed** → metadata-restore
+ lazy-materialize on attach; **not installed** → apply the exact unknown-kind-preserved
policy (dead-but-closable leaf with a message, metadata kept for a future install, never
dropped). `ExtensionViewLeaf` must render that uninstalled/failed state too (an extension can
be removed while a pane is open — `AppHostSurface.tsx:43-49` documents the stale-id reality).

**Depends on:** WS4 for the isolated mount (a pane runs an extension's synchronous UI — same
sandbox requirement as a modal view, more surface area). **Effort:** ~2 weeks. **Build order
(research pass 4):** `providerKind` → manifest enum → `SessionMeta`/spawn opts →
`sessionManager` branch → `ExtensionViewLeaf` + ViewMount registry + render short-circuit →
`derive` modal/panel branch → `rehydrate` branch → the `Exclude` signature updates.

### WS7 — Contributed surfaces (modals / overlays)
**Goal:** an extension renders its own modal/overlay surface. (Feed/tool renderers are **cut**
— see below and Decision 5.)

**Surfaces registry:** `app/surfaces/registry.tsx` — `{id, Component}` arrays where "add a
surface = one entry, App.tsx never edited." Mechanically extension-friendly, but the
**load-bearing manual paint-order** (`:35-42`, z-50 ties resolved by array index; PR #505
regressed exactly this) blocks a raw extension entry. **Contract needed:** an explicit
`layer`/`priority` field on `SurfaceEntry` (the escape hatch `ConditionOutlet.tsx:47-54`
already prescribes) + a bounded z-band for extension surfaces so a contributed surface
*cannot* cover a first-party modal by tie-break. Extensions ride inside the one `app-host`
slot (hosted through `AppHostSurface`), not as peer `SurfaceEntry`s, because contributed
components can't read `useAppStore`/`useWorkspaceContext` (host internals the ABI forbids).

**Feed / tool renderers — CUT (Decision 5).** Extensions do NOT render custom feed rows.
An extension may ship an MCP tool, and its output renders through the **standard MCP
rendering** the feed already applies to any MCP tool — the provider-neutral `ToolResultRow`
fallback (`src/renderer/src/features/feed/ui/rows/ToolResultRow.tsx`), which runs its own
ordered JSON/MCP/structured/plain probe and "must never branch on provider tool names."

WHY cut: a custom renderer would return third-party React **synchronously into the feed** —
the most trusted, central surface, inline with the user's real work. That both collides with
the ABI's all-async/no-`@renderer/*`/frame-boundary rule *and* reopens a rendering pipeline
that has been a repeated problem area (the renderer rewrite, provider plug-and-play #394).
The safety and complexity cost far outweighs the differentiation. Extension tool output
looking like standard MCP output is an acceptable, safe outcome. Do NOT build the
`ToolRendererContribution` registry the research pass sketched; it is intentionally
out of scope. Cutting it also removes WS7's only sandbox-synchronous-React problem — the
remaining surface path rides the existing `app-host` slot.

**Depends on:** WS4 (surfaces run extension UI through the iframe host). **Effort:** ~3-5 days
(surfaces only, down from ~2-3 weeks once feed renderers are cut).

### WS8 — SDK package + API versioning (threaded alongside)
**Goal:** remove the authoring friction and make v2 cheap.

**No SDK exists** (`grep agent-code-extension-api` = one hit, the planned Task C1). Authors
today hand-roll (research pass 6, `docs/extensions/authoring.md §3-4`): 4 React/jsx/react-dom
shim files reading `globalThis.__agentCodeHost`; a vite config with aliases (not `external`)
+ `lib` + `inlineDynamicImports` + `cssCodeSplit:false` + `define:{'process.env.NODE_ENV':
'"production"'}` (missing it → `process is not defined` at `activate()`); and **committing
`dist/`** (install is a source tarball, not a release asset). **Build:** a
`packages/agent-code-extension-api` submodule (modeled on the other `packages/*` repos)
exporting the typed `AgentCodeApiV1` + `ExtensionModule`/`Context`/`ViewMount` (canonical
source `apps/api/types.ts` + `moduleContract.ts`), the `AgentCodeHostGlobal` type + the 4
shims, the vite preset, a manifest type + zod mirror, and a scaffold (the `agent-code-timer`
repo is the de-facto reference). **In the frame model (WS4)** the React-from-host shims
largely dissolve (the child bundles its own React) — so sequence the SDK's shim story after
the isolation decision.

**Versioning:** `SUPPORTED_API_VERSION=1` (`manifest.ts:17`), rejected with a clear message
if mismatched (`:184-188`). v1 freezes once an out-of-repo extension depends on it. **v2 =
~30 lines:** a new `AgentCodeApiV2` interface, a `createHostV2` alongside `createAppHostApi`,
dispatch on manifest `apiVersion`, `SUPPORTED_API_VERSION` → a supported *set* `{1,2}`. No
edit to the v1 file — the reason the surface is one nested object, not 153 flat methods.
**Effort:** ~3-5 days, threaded.

## 6. Cross-cutting invariants — the do-not-break list

1. **Extension state / settings / keybindings never enter the zustand-persist `Settings`
   blob** (#249 black-screened launch twice). Values live in `EXTENSION_STATE_DIR` via
   `extension:storage-*`, or in the `commandKeybindingOverrides` map (which is designed to
   preserve unknown ids).
2. **`AppDefinition` stays a manifest superset-by-one** (`apps/types.ts`). Capabilities go
   through `AgentCodeApiV1`, never as fields on `AppDefinition` — adding host state to it
   breaks the Stage-2 frame swap.
3. **Every `AgentCodeApiV1` method returns a Promise** — the highest-value forward-compat
   decision; never make one synchronous "because it obviously is."
4. **The runtime React handshake stays OFF the ABI** (`__agentCodeHost`, not an API field) —
   a host React-major bump must not be an ABI break.
5. **Per-call concat, never a module-scope snapshot** — an adversarial audit found eight
   module-scope snapshots that couldn't react to an install; don't add a ninth.
6. **First-party callers unchanged** — every threaded parameter is additive with an empty
   default.
7. **CSP: amend only `script-src`/`connect-src` etc. with `agent-code-ext:`; never add
   `unsafe-eval`/`blob:`/`file:` to script-src, and never touch `worker-src`** (the #513
   Monaco-blob-worker comment is load-bearing).
8. **New surface-registry entries go at the END of their array** (paint order; PR #505
   regression) — until WS7 adds the explicit `layer`/`priority` field.
9. **Declarative contributions import no extension bundle at registration time** — the
   palette/editor/Settings populate from manifests alone; the moment a piece needs the loaded
   module, it has crossed into WS4 territory.
10. **Update path is intentionally the install path** (`rm`+`rename`, ledger row replaced by
    id) — don't add a separate updater; do add deactivation before the swap.

## 7. Security model & threat evolution

- **Today:** single-user desktop, all code from this repo. Threat model = "mistake, not
  attack." Same-realm extensions reach `window.api` directly; every guard is an accident
  guard. Accepted worst case: storage-namespace confusion.
- **After WS4:** each extension in its own frame; identity from `event.senderFrame`/
  `MessagePortMain`. The storage namespace becomes a real authority boundary.
- **After WS5:** declared `permissions`, consent bound to `(extensionId, sha256, capability)`,
  enforced at the RPC router. Tier 1 advisory same-realm; Tier 2 consent-gated; Tier 3
  enforceable only post-frame.
- **Never (deliberately):** OS notifications (Tier 3, interrupt risk), a marketplace (repo
  name = trust), background extensions by default (a product decision).

## 8. Sequencing & dependency graph

```
WS0 (bugs) ─┬─► WS1 (command spine) ─► WS2 (keybinds) ─► WS3 (settings)   [no sandbox]
            │        (declarative tranche — ship first, high value, low risk)
            │
            └─► WS4 (sandbox) ─┬─► WS5 (capability/consent)
                               ├─► WS6 (panes)              [needs isolated mount]
                               └─► WS7 (contributed surfaces)
WS8 (SDK + versioning) ── threaded; its shim story sequences AFTER WS4's fork decision.
```
WS1-3 are independent of the sandbox and should land first. WS4 is the pivot. WS5/6/7 fan out
from it. The §9 fork decision (Option A vs B) gates WS4's whole shape and should be settled
before WS4 starts.

## 9. Decisions — RESOLVED

All six are settled; see the **Decisions locked** block at the top of this doc. Summary:

1. Iframe fork → **Option A** (plain iframe + `MessagePortMain`).
2. Keybinding conflict → **accept-and-report at load**.
3. Settings placement → **per-extension section**.
4. Uninstall → **preserve** values/overrides.
5. Feed/tool renderers → **CUT**; extension MCP tools use standard MCP rendering.
6. SDK → **separate submodule repo**.

## 10. Effort summary

| Workstream | Sandbox? | Effort |
| --- | --- | --- |
| WS0 bugs + ledger | no | ~1 day |
| WS1 command spine | no | ~2-3 days |
| WS2 keybindings | no | ~3-5 days |
| WS3 settings rows | no | ~3-5 days |
| WS4 sandbox substrate | — | ~2 weeks |
| WS5 capability + consent | needs WS4 for teeth | ~1 week |
| WS6 panes | needs WS4 | ~2 weeks |
| WS7 contributed surfaces (feed renderers cut) | needs WS4 | ~3-5 days |
| WS8 SDK + versioning | threaded | ~3-5 days |

**Total: ~7-10 weeks** for the platform, one engineer, compressible
with parallel work on the independent declarative tranche (WS1-3) and the SDK.

## 11. Key file:line anchors (quick reference)

- Manifest schema + contributes: `src/main/extensions/manifest.ts:65,72,82,108,131-148`
- The ABI + tiers: `src/renderer/src/apps/api/types.ts:9-85`
- Mount contract + context: `src/renderer/src/apps/host/moduleContract.ts:24,36-47`
- The bridge: `src/renderer/src/apps/host/viewBridge.tsx:20-141`
- The host: `src/renderer/src/apps/host/ExtensionHost.ts:65,86-104,111-141`
- Install/ledger: `src/main/extensions/install.ts:205-246`; `ledger.ts:16,30,54,78`
- Command wiring: `registry.ts:183` (`buildCommandRegistry`), `catalog.ts`,
  `CommandPalette.tsx:808`, `derive.ts:57`
- Keybinds: `command-keybindings/{defaults,resolve,reservations,normalize}.ts`;
  `useKeybinds.ts:243`; `CommandKeybindingsRow.tsx`
- Settings: `settingsRegistry.ts:92-287,384`, `SettingsList.tsx:234,248`, `storage.ts:116-177`
- Panes: `TileTree.tsx:96-171`, `providerKind.ts:47`, `TerminalLeaf.tsx`,
  `sessionManager.ts:515,1161`, `rehydrate.ts:615-632`, `uiShell/types.ts:308`
- Isolation: `scheme.ts`, `mainWindow.ts:316-349`, `preload/index.ts:23`,
  `remote/protocol/{messages,scope}.ts`, `index.html:28`, `ipc/extensions.ts:14-30`
- Capability/consent: `editorFsRootRegistry.ts:9-98`, `WorkflowSourceApprovalStore.ts:18-61`
- Registries to copy/avoid: `conditions-core/view.ts:67-143`, `ConditionOutlet.tsx:41-77`;
  `registry.renderer.capabilities.ts:320-337`; `formatters/index.ts:17-43`
- Theme: `settings/theme.ts:26,83-135`, `savedThemes.ts`, `customAppearance.ts:344-481`

## Appendix — prior doc status

| Doc | Status |
| --- | --- |
| `2026-07-20-extension-platform-investigation.md` | Stale snapshot; findings valid, anchors/§8 obsolete. **Superseded by this doc.** |
| `2026-07-20-extension-platform.md` | Original full plan; **aligned + extended** here, re-anchored to the merge. |
| `2026-07-20-extension-platform-stage1.md` | Superseded (its own header); Task 5/6 obsolete post-merge. |
| `2026-07-22-extension-contributions-into-merged-systems.md` | Active near-term plan; **its 3 pieces = WS1-3 here**, expanded with the keybind-editor correction. |
