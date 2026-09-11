# Re-enable xterm WebGL rendering on the xterm beta line

**Issue:** #871 (refs #768, #789, #841)
**Branch:** `perf/reenable-xterm-webgl` (worktree `.worktrees/xterm-webgl-beta`, from `origin/main` @ `95e37bf4`)
**Decision:** approved by the user in chat on 2026-09-11 ("we should honestly just move to the beta versions asap").

## Problem

`WEBGL_RENDERER_ENABLED = false` in
`src/renderer/src/workspace/terminal/xtermWebglRenderer.ts` since 2026-09-08
(`fcf70d0a`, PR #841). The pinned `@xterm/addon-webgl@0.19.0` corrupts its
texture atlas under provider-TUI output (garbled/interleaved glyphs, mid-word
substitutions, stale inverse blocks; #789, re-reported 2026-09-08). The
upstream fix, xterm.js #5883, ships only in `@xterm/addon-webgl@0.20.0-beta.219+`,
which peer-requires `@xterm/xterm ^6.1.0-beta.304`. The switch's comment said
to wait for a stable 0.20.0; npm on 2026-09-11 still has only `0.19.0` stable.

Cost of staying off (#768): xterm 6's DOM renderer rebuilds every dirty row's
spans on each repaint, and Claude Code repaints the whole viewport in `?2026`
synchronized-output brackets, so almost every row is dirty on every frame. Every
raw terminal surface pays it (agent terminal view mode, plain shells, OpenCode
Terminal), per visible lane.

## Evidence that changed the decision

- VS Code's `main` `package.json` (checked 2026-09-11) depends on exactly this
  line: `"@xterm/xterm": "^6.1.0-beta.304"`, `"@xterm/addon-webgl": "^0.20.0-beta.300"`.
  xterm.js publishes betas continuously from `master`; its largest consumer
  ships them. "Don't put the core terminal on a beta" was the only argument for
  waiting, and it is much weaker than it looked.
- npm dist-tags (2026-09-11): `@xterm/xterm` latest `6.0.0` / beta
  `6.1.0-beta.304`; `@xterm/addon-webgl` latest `0.19.0` / beta `0.20.0-beta.300`;
  `@xterm/addon-fit` latest `0.11.0` / beta `0.12.0-beta.301` (peer
  `@xterm/xterm ^6.1.0-beta.304`).

## Changes

1. **Dependencies (exact pins).** `@xterm/xterm 6.1.0-beta.304`,
   `@xterm/addon-webgl 0.20.0-beta.300`, `@xterm/addon-fit 0.12.0-beta.301`.
   Exact, not `^`: a caret on a prerelease floats to any newer beta of the same
   tuple on the next lockfile refresh, so an unrelated `npm install` could move
   the core terminal. Upgrades on this line must be deliberate, one PR each.
   `@xterm/headless` (main-process screen parsing, no renderer) is out of scope.
2. **Switch on.** `WEBGL_RENDERER_ENABLED = true`. The constant and the
   `enabled` parameter stay: flipping back to `false` is the one-line rollback
   if corruption reappears on the beta, and the DOM path remains the tested
   fallback for every failure.
3. **Delete the 0.19.0 atlas bridge** — the `invalidateTextureBindings`
   subclass, the `onAdd/RemoveTextureAtlasCanvas` listeners and the microtask
   repaint scheduler — exactly as the switch's own comment instructs. #5883 fixes
   the atlas bugs inside the addon; the bridge reached into private fields
   (`_renderer._glyphRenderer.value.setAtlas`) whose shape the beta may not keep,
   so leaving it would be a live hazard, not just dead code.
4. **Rewrite the WHY comments** to record the new state, the evidence, the
   rollback, and the follow-up (move to stable `6.1.0` / `0.20.0` once released).

## Worktree isolation (important)

Every worktree and the main checkout normally symlink ONE `node_modules`
(`ln -s ../../node_modules`). Installing the betas through that symlink would
silently change xterm for every other branch, session and the running dev app.
This worktree therefore gets its own real `node_modules`
(`NODE_ENV=development npm install --include=dev`, Node 24 to match CI).

## Tests (TDD)

- RED first: change the "does not attach anything by default" case into
  "attaches WebGL by default" — fails while the constant is `false`.
- Remove the four bridge-only cases (version pin check, atlas-burst repair,
  partial atlas subscription cleanup, bridge-failure fallback); keep the ten
  attach / readiness / teardown / late-import / construction / activation /
  context-loss / re-entrancy / explicit-disable cases, adjusted to the smaller
  addon surface.
- Verify once at the end (Node 24): `npm run typecheck`, targeted xterm suites
  (`xtermWebglRenderer`, `AgentTerminalLeaf.*`, `TerminalLeaf.*`,
  `agentTerminalFollow*`), then CI `quality-gate` — which also runs
  `test:package`, the only local-equivalent check that the production bundle
  still builds with the new packages.

## Due diligence on the core bump

Before relying on tsc alone, review xterm.js PRs labelled breaking since 6.0.0
against how our 9 importing files use xterm (options, `loadAddon`, `refresh`,
buffer APIs, `onRender`, theme). tsc catches type-level breaks; behavior-level
changes need this read plus the manual soak.

### Result (2026-09-11)

xterm.js PRs labelled `breaking-change` merged after 6.0.0 (published
2025-12-22) and before 6.1.0-beta.304 (2026-08-30): #5487 (move `customGlyphs`
into the webgl addon), #5840 (APC parser rework, `registerApcHandler` identifier
change), #5874 (clipboard addon). `git grep` finds no use of `customGlyphs`,
APC handlers, the clipboard addon, or the options removed in #5462
(`windowsMode`, `fastScrollModifier`) anywhere in `src/` — none of them touches
this app. `codex-headless` (submodule) declares `@xterm/xterm ^6.0.0` but is
compiled from source via Vite alias, not npm-installed, and its source only
imports `@xterm/headless`, so no second `@xterm/xterm` enters the tree.

## Lockfile: surgical, not whatever `npm install` wrote

`npm install --save-exact <the three betas>` also pruned vitest's nested
`esbuild 0.28.2` (28 lock entries) in favour of the root `esbuild 0.25.12` — an
arborist dedupe unrelated to xterm that could change test-runner behaviour. The
committed lockfile is `main`'s with ONLY the three `@xterm/*` entries and the
root dependency specs replaced, validated with a clean `npm ci` (which also
reinstalled vitest's nested `esbuild 0.28.2`). Diff: lockfile 20+/14-,
manifest 3+/3-.

## Scope change after review (2026-09-11, user-approved): local core patch

Two orchestrated reviewers (A runtime/Codex, B integration/Claude) reviewed
the first version. A found — and independent source reading, a web/GitHub
research pass and integration runs confirmed — an **upstream core bug in the
pinned beta**: `CoreTerminal.resize()` calls `WriteBuffer.flushSync()`
(xterm.js bf7c95b6 / #5599, since 6.1.0-beta.96), which re-applies chunks
the async writer already parsed (duplicate output, write callbacks fired
twice) and stops at an empty-string chunk, discarding everything behind it.
Known upstream in open xterm.js #6154 (maintainer: "resize is a sync action
and may not call WriteBuffer.flushSync"); Superset patches the same bug
(superset-sh/superset#7188). It predates the atlas fix, so no beta avoids it.

Evidence gathered (scratchpad harnesses, not committed):
- Generic streaming (Node, both versions, differential): rare — 0 replays in
  32 compact runs; 11 replayed chunks in one 6 MB smoke run on the beta, 0 on
  6.0.0. It needs a slow-to-parse chunk followed by a resize.
- Agent Code's pane attach IS that shape (`replay(term, [512 KiB buffer,
  backlog])` + `fit()`): with the REAL `terminalInputForwarder`, 7/20
  simulated attaches leaked terminal query replies into the agent's stdin and
  left the #745 latch broken for the next replay; 0/20 on 6.0.0; 0/20 patched.

Decision (user): keep the beta line, apply the fix locally, lock and document.
Implemented as the maintainer-endorsed narrow form — remove the flush from
`resize()` (stable 6.0.0 semantics) — rather than Superset's larger rewrite of
`flushSync`/`_innerWrite`, which targets an async image-decoder case we do not
have (no parser handlers registered in `src/`).

- `scripts/patch-xterm.mjs` (postinstall, before electron-rebuild): exact-
  string edit of `resize()` in `lib/xterm.mjs` + `lib/xterm.js`, verified
  against the exact pin; refuses to run on any other version or bundle shape
  (fails the install loudly), idempotent, self-verifying. A script instead of
  patch-package because both bundles are minified (a single 391 KB line), so a
  diff would be ~0.8 MB of unreviewable patch. Its header is the documentation:
  bug, trigger, app impact, and exactly what to do on a bump.
- `xtermResizeFlushPatch.test.ts`: marker in both bundles + three
  deterministic behaviour cases (resize inside a write callback; empty write
  + resize; resize after the writer yielded). All 7 failed on the unpatched
  beta, pass patched, and the three behaviours pass on stable 6.0.0.

Also fixed from the same review round:
- A2 — context-loss fallback kept the WebGL grid (WebGL floors the cell width,
  DOM keeps it fractional) so text could clip; `attachXtermWebglRenderer` now
  takes an options object with `onRendererChange`, fired after WebGL takes
  over and after a real fallback (never when disabled/failed/after teardown),
  and the three hosts route it into their existing ownership-gated fit.
- B1 — the Electron pixel harness (`scripts/smoke-terminal-renderer.mjs`)
  asserted `--control` MUST reproduce corruption, which is guaranteed to fail
  on the fixed addon; both modes now must render clean.
- B2 — header no longer claims VS Code ships addon-fit; B3 — lockfile numbers;
  B4 — the two TerminalLeaf suites mock the renderer module like the
  AgentTerminalLeaf suites. B5 (upstream-watch entry for xterm) not taken: the
  watcher and its issue checklist are provider-CLI specific; the patch script's
  version guard is the trigger on any bump.

## Manual soak (required before merge — the user; agents never launch the app)

Heavy Claude Code / Codex output in terminal view, OpenCode Terminal, a plain
shell; scroll, resize, switch lanes, sleep/wake. Watch for garbled or
interleaved glyphs, characters replaced mid-word, stale inverse blocks. If
anything looks wrong: copy the garbled text — a clean clipboard means the
renderer (flip the switch back), a dirty one means the data path.

## Out of scope

- `@xterm/headless` upgrade.
- Any other renderer or perf change from #768 (dispatcher registry etc.).
