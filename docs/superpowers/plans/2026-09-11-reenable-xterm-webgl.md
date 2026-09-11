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

## Manual soak (required before merge — the user; agents never launch the app)

Heavy Claude Code / Codex output in terminal view, OpenCode Terminal, a plain
shell; scroll, resize, switch lanes, sleep/wake. Watch for garbled or
interleaved glyphs, characters replaced mid-word, stale inverse blocks. If
anything looks wrong: copy the garbled text — a clean clipboard means the
renderer (flip the switch back), a dirty one means the data path.

## Out of scope

- `@xterm/headless` upgrade.
- Any other renderer or perf change from #768 (dispatcher registry etc.).
