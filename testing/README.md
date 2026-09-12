# Agent Code Test Infrastructure

Tests live **beside the production module they protect** (`foo.ts` →
`foo.test.ts`). This directory is only for the few things that *can't* be
colocated:

- **`fixtures/`** — the rendering corpus (`rendering-bundles/`,
  `rendering-recordings/`) replayed by `src/renderer/src/rendering/bundleCorpus.test.ts`
  and `recordingCorpus.test.ts`. The regression net for the rendering pipeline.
- **`setup/renderer.ts`** — happy-dom setup file for the `renderer` Vitest project.
- **`unit/channels/`, `unit/proxy/`** — tests for `packages/claude-code-headless`
  (a git submodule). They live here because a test file can't be colocated
  *inside* a submodule from this repo.

Everything else — pure functions, reducers, selectors, mappers, ledgers,
components — is colocated under `src/`. If you're reaching for `testing/` for a
new test, it almost certainly belongs next to its source instead.

## Commands

```bash
npm test              # all projects
npm run test:unit
npm run test:integration
npm run test:renderer
npm run test:extensions:electron # production iframe/IPC integration in isolated Electron
```

## Projects (see `vitest.config.ts`)

- `unit` — node env: `src/**/*.test.ts`, `testing/unit/**`
- `system` — node env: `**/*.system.test.ts` plus the existing legacy
  `**/*.integration.test.ts` files
- `renderer` — happy-dom: `**/*.renderer.test.{ts,tsx}` (+ `testing/setup/renderer.ts`)

## Policy

The extension Electron system test is included in `npm test`, `test:system`, and
CI. Prepare its pinned browser dependency once after `npm ci` with
`node node_modules/electron/install.js`; the test itself never downloads binaries.
Its colocated fixtures under `src/main/extensions/testing` and
`src/renderer/src/apps/host/testing` use temporary state, the real installer and
preload bridge, a file-origin host, and both production content security policies.
They cover activation/theme ordering, failed imports and mounts, missing bundles,
permission denial, storage, startup deadlines, teardown, and retry. The launcher
in `scripts/check-extension-frames.mjs` only builds and owns that isolated process.
It does not replace the application restart, shared runtime, command, or workspace
acceptance checks tracked by the extension completion plan.

The same system file also runs the managed-runtime transport journey; use
`npm run test:extensions:electron -- --runtime-only` for that faster subset.
After an app build, add `--runtime-preload out/preload/extensionRuntime.js` to
exercise the actual emitted preload at its original path.
It tests the real hidden runtime, correlated commands, logical view requests,
background ticking, update/uninstall cancellation, retry and network denial.
It also verifies asynchronous deactivation with revoked API authority, forced
shutdown of hung cleanup, and disposal of every runtime window. The launcher
requires an explicit completion record after all assertions and teardown; a zero
exit from an early app shutdown is not sufficient.
The full frame journey also exercises public v2 command routing and two real
view windows against one engine; the runtime subset covers startup/lazy events
and pause/resume after cancelled quit. Whole-app focus, native keyboard routing,
restart and packaged authoring acceptance remain separate checks.

Do not add `scripts/test-*.ts` files — the old script tests were incident
probes, not the test architecture. New coverage is a Vitest file next to its
source.
