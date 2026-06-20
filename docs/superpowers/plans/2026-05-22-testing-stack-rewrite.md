# Testing Stack Rewrite Plan

Status: prerequisite plan, written 2026-05-22.

## Why This Comes Before Rendering

The rendering rewrite needs TDD, but the repository does not yet have a real
testing stack at the root. It has many focused `tsx scripts/test-*.ts` files,
some package-local tests, and a standalone Electron rendering harness. Those
tests have been useful, but they are not enough for a rewrite that must prevent
old behavior from coming back.

The failure mode is visible in the issue/PR history: fixes were shipped with
small one-off scripts, then adjacent behavior regressed because there was no
shared test vocabulary for fixtures, ownership assertions, coverage, watch
mode, CI grouping, or Electron smoke coverage.

Before the rendering pipeline rewrite, we need one testing architecture that
answers:

- What framework do new tests use?
- Where do tests live?
- How do we separate fast pure tests from Electron/runtime tests?
- How do fixtures get named, stored, redacted, and reused?
- Which command must pass before merging?
- How do we migrate the existing `scripts/test-*.ts` tests without losing their
  debugging value?

## Current State

Root `package.json` currently has many ad hoc test scripts:

- `test:feed-render-model`
- `test:ghost-fallback`
- `test:semantic-committed-text`
- `test:semantic-fold-codex-replace`
- `test:codex-optimistic-submit`
- `test:session-ownership`
- `test:orchestration-mcp`
- and many others

Most are direct `tsx --tsconfig ... scripts/test-*.ts` programs using Node
assertions. They are easy to run individually but hard to discover, hard to
watch, hard to group, and hard to enforce consistently.

There is also:

- `testing/rendering/`: standalone Electron rendering harness
- `packages/agent-voice-dictation`: uses `node --import tsx --test`
- `packages/agent-transcript-parser`: uses a `tsx testing/verify.ts` command
- `packages/codex-headless`: has package-local `tsx` script tests

So the repo already values pure tests and fixture scripts. The missing piece is
a root test runner and a migration path.

## Scripts Directory Policy

The root `scripts/` directory should stop being the place where tests and
diagnostic programs accumulate. It is currently a junk drawer: test programs,
manual proxy harnesses, packaged-resource build steps, upstream drift checks,
and runtime-tool fetchers all live under the same name. That makes future
agents copy the pattern and add more one-off files instead of improving the
test suite.

Target rule:

- No `scripts/test-*.ts`.
- No new test commands that execute arbitrary `tsx scripts/...` files.
- No manual debugging harnesses under `scripts/`.
- Operational build/release utilities must live under a named tool area, not a
  mixed test directory.

Recommended destinations:

| Current kind | Current examples | Destination |
|---|---|---|
| Unit/integration tests | `scripts/test-feed-render-model.ts`, `scripts/test-ghost-fallback.ts` | colocated `*.test.ts` files under `src/` or `packages/`, run by Vitest |
| Shared test fixtures/builders | repeated object builders in test scripts | `testing/support/` and `testing/fixtures/` |
| Manual proxy harnesses | `scripts/proxy-harness*.mts` | `tools/proxy-harness/` or `testing/manual/proxy-harness/` |
| Runtime fetch/verify tools | `scripts/runtime-tools/*.mjs` | `tools/runtime/` |
| Build packaging helper | `scripts/copy-packaged-resources.mjs` | `build/copy-packaged-resources.mjs` |
| Upstream drift checker | `scripts/check-upstream.mjs` | `tools/upstream/check.mjs` |

The naming matters. If a file is a test, it belongs to the test runner. If a
file is a manual diagnostic program, it belongs under `tools/` or
`testing/manual/` with a README that says it is not CI. If a file is part of
packaging or release automation, it belongs under `build/` or `tools/`.

The final state should allow `scripts/` to be deleted entirely, or kept empty
only if a third-party convention absolutely requires it. Agent Code should not
teach future agents that `scripts/test-whatever.ts` is acceptable.

## Framework Decision

Use **Vitest** as the root test framework.

Why Vitest:

- It fits the existing Vite/electron-vite/React/TypeScript ESM stack.
- It can run fast pure Node tests and renderer-oriented tests under different
  projects/environments.
- It provides watch mode, filtering, reporters, coverage integration, and
  familiar `describe/it/expect` structure without adopting Jest.
- It lets us migrate the existing `tsx` scripts incrementally: first wrap their
  assertions in `.test.ts` files, then delete the script command once migrated.
- It is a better home for rendering ownership assertions than standalone
  scripts because failures become discoverable by file/test name and can run in
  CI as a suite.

Use **Playwright** later for browser/Electron smoke and visual workflow tests.
Do not make Playwright the first testing framework. It is too heavy for the
pure ownership/compiler tests that rendering needs most.

Keep package-local `node:test` only where a package already uses it and there
is no immediate need to migrate. The root standard for new app tests should be
Vitest.

## Test Layers

### Layer 1: Pure Unit Tests

Command: `npm run test:unit`

Purpose:

- pure functions
- reducers
- selectors
- mappers
- ownership ledgers
- diagnostics
- transcript conversion
- queue and optimistic ownership rules

Environment: Node.

These should be the default tests for rendering and most app logic.

### Layer 2: Renderer Integration Tests

Command: `npm run test:renderer`

Purpose:

- React component behavior where DOM matters
- renderer store integration without Electron main process
- feed row rendering smoke where a pure item model is already prepared

Environment: jsdom or happy-dom. Pick one during implementation after checking
the smallest dependency surface and compatibility with React 18. Do not use DOM
tests for ownership decisions that can be asserted in pure tests.

### Layer 3: Node/Main Integration Tests

Command: `npm run test:node`

Purpose:

- main-process helpers
- file-system indexing
- session ownership and provider lookup
- debug bundle storage
- process locks

Environment: Node with temp directories. No real user data paths unless the
test explicitly uses a redacted fixture.

### Layer 4: Electron Harness And Smoke

Command: `npm run test:e2e` eventually.

Purpose:

- Electron startup
- IPC wiring
- rendering harness smoke
- high-value user workflows that cannot be tested as pure functions

Tooling: Playwright or an Electron-aware runner after the Vitest migration is
stable.

The existing `testing:rendering` harness stays useful. It should not be the
primary regression suite. It is an investigation harness and later a smoke
target.

## Proposed Files

Add:

```text
vitest.config.ts
testing/
  fixtures/
    rendering/
    sessions/
    providers/
  support/
    builders/
    tempDirs.ts
    assertions.ts
    redact.ts
```

Use colocated tests for app code:

```text
src/renderer/src/features/feed/model/renderModel.test.ts
src/renderer/src/workspace/semantic/foldEvent.test.ts
src/renderer/src/workspace/ghosts.test.ts
src/main/sessions/historyLoader.test.ts
```

Use shared fixture builders when a test spans multiple modules:

```text
testing/support/builders/rendering.ts
testing/support/builders/transcript.ts
testing/support/builders/semantic.ts
```

Do not keep adding new root-level `scripts/test-*.ts` files except for manual
diagnostic tools that are explicitly not part of CI.

## Package Scripts

Target root scripts:

```json
{
  "test": "vitest run",
  "test:watch": "vitest",
  "test:unit": "vitest run --project unit",
  "test:renderer": "vitest run --project renderer",
  "test:node": "vitest run --project node",
  "test:render-pipeline": "vitest run --project unit src/renderer/src/render-pipeline",
  "test:legacy": "npm run test:review-fixes"
}
```

During migration, keep legacy script commands working. Deleting them should be
one explicit cleanup phase after equivalent Vitest tests exist.

## Fixture Policy

Fixtures need rules before the rendering rewrite starts.

- Fixtures must be small and named after the behavior, not only the issue
  number.
- Large debug bundles stay outside git unless reduced into minimal redacted
  fixtures.
- Every fixture should say what it proves.
- Provider ids may be preserved if they are structurally important, but user
  text and local paths should be redacted unless the literal content is part of
  the bug.
- A fixture should include raw input and expected ownership output whenever
  possible.

Example:

```text
testing/fixtures/rendering/
  codex-resume-proxy-replaces-empty-rollout-shell.fixture.ts
  codex-stale-web-search-semantic-history.fixture.ts
  codex-optimistic-user-buried-by-work-row.fixture.ts
  claude-sidecar-prompt-suggestion-leaks.fixture.ts
```

## Migration Phases

### Phase 0: Baseline Inventory

- List every root `test:*` script and the module it protects.
- Classify each as unit, renderer, node integration, package-local, or manual.
- Mark which ones protect open issues: #172, #183, #241, #174, #98, #90.

Exit criteria:

- There is a migration table mapping each current script to a future Vitest
  file or a deliberate manual tool.

### Phase 1: Install And Configure Vitest

- Add Vitest and coverage tooling.
- Add `vitest.config.ts` with projects for `unit`, `renderer`, and `node`.
- Add one trivial test in each project.
- Add root scripts without removing existing scripts.

Exit criteria:

- `npm run test`, `npm run test:unit`, `npm run test:renderer`, and
  `npm run test:node` all run successfully.

### Phase 2: Migrate Existing High-Value Scripts

Start with rendering-adjacent tests:

- `scripts/test-feed-render-model.ts`
- `scripts/test-ghost-fallback.ts`
- `scripts/test-semantic-committed-text.ts`
- `scripts/test-semantic-fold-codex-replace.ts`
- `scripts/test-codex-optimistic-submit.ts`
- `scripts/test-codex-semantic-channel.ts`

Keep behavior identical first. Do not improve implementation while migrating.

Exit criteria:

- Existing scripts and new Vitest equivalents both pass.
- The Vitest tests are the ones referenced by the rendering rewrite plan.

### Phase 3: Add Fixture Builders

- Add builders for entries, semantic turns, ghosts, Codex rollout rows, Claude
  history rows, queued prompts, optimistic users, and stream phases.
- Replace copy-pasted object blobs in migrated tests with builders.

Exit criteria:

- New rendering tests can be written in terms of behavior, not giant object
  literals.

### Phase 4: CI Gate

- Define `npm run test` as the standard fast suite.
- Keep Electron/harness tests out of the default fast suite until they are
  stable and reasonably quick.
- Add coverage reporting after the test layout has settled.

Exit criteria:

- A PR can clearly say which test layer it affects and which command proves it.

### Phase 5: Legacy Cleanup

- Delete migrated `scripts/test-*.ts` files.
- Move manual-only proxy/debug tools out of `scripts/` into `tools/` or
  `testing/manual/`.
- Move build/runtime/upstream automation out of `scripts/` into `build/` or
  `tools/`.
- Remove redundant `test:*` package scripts that point at old script files.
- Delete the root `scripts/` directory once nothing legitimate remains.
- Keep a compatibility alias only if an active plan or PR still references it.

Exit criteria:

- The root test surface is discoverable from `npm run test:*`, not a long list
  of one-off scripts.

## Rendering Rewrite Dependency

The rendering rewrite should not start production behavior changes until:

- Vitest is installed and configured.
- The current rendering scripts have Vitest equivalents.
- Fixture builders exist for rendering ownership inputs.
- `npm run test:render-pipeline` exists, even if the first pipeline tests wrap
  current `deriveFeedRenderModel` behavior.

After that, every rendering PR can follow real TDD:

1. Add or reduce a fixture.
2. Write the failing ownership/diagnostic assertion.
3. Change the pipeline.
4. Prove old issue fixtures still pass.

## Non-Goals

- Do not build a full Playwright/Electron suite before pure tests exist.
- Do not migrate every package-local test in the first pass.
- Do not rewrite rendering behavior while converting tests.
- Do not make snapshots the main assertion style for ownership logic.
- Do not block manual harness work; just stop treating the harness as the only
  regression strategy.

## First PR Boundary

The first testing PR should do only this:

1. Add this plan.
2. Add Vitest config and root scripts.
3. Add one tiny test per project.
4. Migrate `test:feed-render-model` or `test:ghost-fallback` as the first real
   proof.
5. Leave legacy scripts in place.

That gives the repo a testing spine without mixing framework migration with the
rendering architecture rewrite.
