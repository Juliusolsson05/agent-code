# OpenCode Bundled Runtime Plan

**Issue:** #994 (feat). Related context: #993 (installed-app PATH blindness).
**Branch:** `feat/opencode-bundled-runtime`, based on `main` @ `cb6b334e`

**Goal:** A fresh install of Agent Code runs OpenCode panes with zero user
setup: the `opencode` CLI ships inside the app as a `third_party` managed
runtime binary, resolved ahead of PATH, surfaced as "bundled" in the SetupGate,
and versioned by app updates instead of npm.

## Research findings (already verified, do not re-derive)

- Upstream `anomalyco/opencode` release **v1.18.31** publishes CLI assets
  `opencode-darwin-arm64.zip` and `opencode-darwin-x64-baseline.zip` (plus
  `-x64.zip`, linux/windows variants we do not ship). Each zip contains
  exactly one `opencode` binary (arm64: 144 MB raw / 46 MB zipped).
- Pinned hashes (computed from the actual assets, 2026-09-18):
  - `darwin-arm64`: archive sha256 `caf7f31f…8d34e` (full value in manifest),
    46273106 bytes, binary sha256 `16c960ba…fb198`
  - `darwin-x86_64`: archive sha256 `ef4dcd35…244bb`, 48467280 bytes,
    binary sha256 `9cd3d83b…c37a8`
- `opencode --version` prints the bare semver (`1.18.31`) — works for both
  the fetch sanity check and the resolver's real-exec probe.
- `otool -L` shows only system dylibs (libicucore, libresolv, libc++,
  libSystem) — the no-Homebrew linkage gate is safe.
- WHY `x64-baseline` for Intel: the baseline build runs on every x86_64 Mac
  (no AVX2 assumption); the perf delta is irrelevant for a CLI we spawn
  intermittently, and the two assets were byte-identical in this release
  anyway.
- License: MIT ("Copyright (c) 2025 opencode"), text fetched from the
  v1.18.31 tag.
- Existing pattern to copy exactly: `third_party/tmux` (single-binary tool,
  cache stores the extracted binary) + `fetch-tmux.mjs`/`verify-tmux.mjs`.
  mitmproxy is the multi-file-archive variant — NOT our shape.

## Changes

1. **`third_party/opencode/`** — `manifest.json` (tool `opencode`, version
   `1.18.31`, urlBase `https://github.com/anomalyco/opencode/releases/download/v{version}`,
   archiveFormat `zip`, executableInsideArchive `opencode`, both darwin
   platforms with archive sha256 + bytes + binarySha256), `README.md`
   (source, why upstream-release instead of npm, bump procedure),
   `LICENSE.md` (upstream MIT text), `.gitignore` (`cache/`, `build/`).
   No binaries committed, ever (AGENTS.md third_party conventions).

2. **`scripts/runtime-tools/fetch-opencode.mjs`** — modeled on
   `fetch-tmux.mjs` with two deltas: extraction is `/usr/bin/unzip -oq`
   into a staging dir (upstream ships zip, not tar.gz; macOS ships unzip),
   and the native version sanity runs `opencode --version` (no `-V` flag).
   Same cache-hit-by-binary-hash, same double-hash verification (archive
   then extracted binary), same "not a postinstall hook" rule.

3. **`scripts/runtime-tools/verify-opencode.mjs`** — three layers like
   verify-tmux: per-arch binary sha256, native-arch `--version` smoke, and
   the darwin `otool -L` no-Homebrew linkage gate.

4. **`package.json`** — `runtime:fetch:opencode` alias; append
   `npm run runtime:fetch:opencode -- --all && node
   scripts/runtime-tools/verify-opencode.mjs --strict` to
   `runtime:prepare:mac`.

5. **`scripts/copy-packaged-resources.mjs`** — add
   `{ id: 'opencode', kind: 'binary' }`. The existing
   `asarUnpack: out/main/runtime/**/*` glob needs no change.

6. **`src/main/setup/runtimeTools.ts`** — add `'opencode'` to
   `BundledToolId`; tmux-shaped resolver (manifest at
   `out/main/runtime/opencode/manifest.json`, binary at
   `out/main/runtime/opencode/<platformKey>/opencode`, find + chmod +
   real-exec probe `['--version']`); `isBundledArchiveAvailable` branch.

7. **`src/main/setup/toolchain.ts`** — in-process bundled override so every
   `getToolPath('opencode', …)` consumer (transcriptEngine's four call
   sites, version probes) gets precedence without per-site edits:
   `refreshToolchainFromState` resolves the bundled binary and records it
   as an override UNLESS a valid manual override exists (the user's
   explicit word beats every probe — same precedence policy as
   prerequisites.ts). `getToolPath` consults the override before
   `cachedPaths`. Dev-mode note: `resolveBundledTool` returns null when the
   build never staged `out/main/runtime/opencode`, so dev machines without
   a primed cache keep today's PATH behavior.

8. **`src/main/setup/prerequisites.ts`** — add `'opencode'` to
   `BUNDLED_TOOL_IDS`. The provider row (already in `TOOL_META` via
   `PROVIDER_TOOL_META`) then reports `found: true`, `source: 'bundled'`,
   and no install prompt when the artifact ships — the mitmdumb precedent
   ("bundled detection takes precedence over PATH").

9. **`src/shared/types/cliUpdate.ts`** — extend the existing "opencode is
   intentionally out of scope" note: when bundled, the CLI's version moves
   with app updates; a version prompt would fight the pin.

10. **Tests** — `src/main/setup/toolchain.bundledOverride.test.ts`: bundled
    beats cached PATH path; a valid manual override beats bundled; a dead
    manual override falls back to bundled; nothing recorded when the
    resolver returns null. The runtimeTools resolver itself follows the
    tmux/cloudflared precedent of being script-verified (fetch + verify +
    build staging) rather than unit-mocked — the probe spawn in a unit test
    would test the mock, not the toolchain.

## Verification

- `npm run runtime:fetch:opencode -- --all` then
  `node scripts/runtime-tools/verify-opencode.mjs --strict` (real 46+48 MB
  downloads; hash-pinned).
- `npx vitest run src/main/setup/toolchain.bundledOverride.test.ts` plus the
  neighboring suites (`cliUpdateOrchestrator`, transcriptEngine, setup
  tests) and typecheck.
- `npm run build:app` then assert `out/main/runtime/opencode/manifest.json`
  and `out/main/runtime/opencode/darwin-arm64/opencode` exist — the
  packaged-app resolution path (`asarUnpack` swap is shared code with tmux).
- `git status` proves no binary or archive entered the tree.

## Out of scope

- Linux/Windows opencode assets (runtimeTools' `getPlatformKey` returns
  null off-darwin; manifests stay darwin-only like tmux).
- Auto-update of the bundled CLI (app-update-managed by design).
- Bundling claude/codex CLIs — separate decisions, separate issues.

## Commit / PR shape

- `docs(setup): plan the OpenCode bundled runtime` (this file; Refs #994)
- `build(runtime): pin the OpenCode CLI 1.18.31 as a bundled runtime tool`
  (third_party + scripts + wiring; Refs #994)
- `feat(setup): resolve bundled OpenCode ahead of PATH` (resolver +
  precedence + gate + tests; Fixes #994)
- PR: `feat(setup): bundle the OpenCode CLI as a managed runtime binary`
