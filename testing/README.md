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
```

## Projects (see `vitest.config.ts`)

- `unit` — node env: `src/**/*.test.ts`, `packages/**`, `testing/unit/**`
- `integration` — node env: `**/*.integration.test.ts`
- `renderer` — happy-dom: `**/*.renderer.test.{ts,tsx}` (+ `testing/setup/renderer.ts`)

## Policy

Do not add `scripts/test-*.ts` files — the old script tests were incident
probes, not the test architecture. New coverage is a Vitest file next to its
source.
