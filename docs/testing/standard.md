# Testing standard

This standard applies to Agent Code and every owned TypeScript submodule. The repositories share one runner and command contract so a developer can move between them without rediscovering how tests are selected, while projects remain separated by the resources they require.

## Required commands

Every repository MUST expose these scripts:

| Script | Contract |
| --- | --- |
| `test` | Run every deterministic test and no live or soak test. |
| `test:core` | Run deterministic tests that do not require external processes, sockets, or providers. |
| `test:system` | Run deterministic tests that cross an operating-system boundary. |
| `test:live` | Run tests that require a real provider, credential, network service, or installed agent. |
| `test:coverage` | Run the deterministic suite with V8 coverage. |
| `test:package` | Verify the built and packed artifact through its public entry points. |
| `test:contract` | Check this command and naming contract locally. |
| `typecheck` | Type-check without relying on test execution. |
| `build` | Produce the repository's distributable output. |
| `check` | Run the complete deterministic merge gate. |

Repositories MAY add `test:renderer`, `test:corpus`, or `test:soak` when those execution boundaries exist. `check` MUST include type-checking, deterministic tests, the build, and package verification.

## File ownership and naming

- `*.test.ts` and `*.test.tsx` are deterministic core tests.
- `*.system.test.ts` crosses a real filesystem, process, socket, watcher, PTY, or application boundary.
- `*.renderer.test.tsx` requires a browser-like renderer environment.
- `*.corpus.test.ts` validates a recorded fixture collection.
- `*.live.test.ts` requires credentials, network access, an installed agent, or a real provider.
- `*.soak.test.ts` repeats work or deliberately runs long enough to detect probabilistic failures.

A test belongs to the repository that owns the behavior. Agent Code may test how it consumes a package's public API, but MUST NOT reach into a submodule's private implementation merely because the superproject has the source checked out.

## Determinism and isolation

`npm test` MUST be safe on a clean machine with no credentials, no personal configuration, and no network access. Loading an ambient `.env`, reading a developer's home directory, or launching an installed provider is live behavior and requires an explicit opt-in variable in addition to the `test:live` command.

Time, identifiers, subprocess output, and transport responses SHOULD be controlled by the test. Polling MUST have a monotonic deadline and stop scheduling work after it expires. Platform-specific skips MUST say which missing capability makes the assertion invalid; silently returning from a test is forbidden.

Global retry is forbidden. A flaky assertion is a defect in either the product or test. Repetition belongs in a scheduled soak job so pull requests still expose the first failure.

## Assertions and seams

Each test SHOULD protect one behavioral contract and name the externally observable result. Assertions SHOULD include the important negative condition when false positives are plausible. Broad snapshots of markup, logs, or serialized internal state are not a substitute for behavioral assertions.

Tests SHOULD use public APIs. When an invariant cannot be observed publicly, add a typed, deliberately narrow test harness instead of casting through `unknown` or `any` to private state. The harness comment MUST explain why the production API cannot express the observation and what would allow the seam to be removed.

## Cleanup

Resources MUST be released after both success and failure. Use `afterEach` or `try/finally` for fake timers, global replacements, temporary directories, sockets, watchers, servers, worktrees, PTYs, and child-process trees. Cleanup that only runs after the last assertion is not sufficient.

WHY this is intentionally strict: most resource leaks are invisible when a file is run alone and only surface as order-dependent failures in the aggregate suite. The suite must be trustworthy under arbitrary file ordering, not merely green on the author's machine.

## Fixtures and corpora

Recorded fixtures MUST document their provider, format/version, capture purpose, and redaction status. Ordinary test runs MUST NOT rewrite tracked fixtures. Intentional regeneration requires `UPDATE_FIXTURES=1` (or an equally explicit repository-specific command) and must leave a reviewable diff.

A parser MUST NOT be the sole oracle for fixtures produced by that same parser. Corpus tests need independent schema, semantic, or hand-authored invariants so a symmetric encoder/decoder bug cannot bless itself.

## Size and comments

Test files SHOULD stay below roughly 400 lines and SHOULD be split before 600 lines unless the majority is declarative test data. Organize by behavioral owner, not by an arbitrary target line count.

Follow the repository comment policy in tests: comments explain WHY the setup or assertion has its shape, which invariant it protects, and what would make it wrong. Comments that only narrate the next line add noise and should be omitted.

## CI contract

Pull requests run the contract check, minimum/current supported Node versions, the deterministic suite, build/package verification, and coverage. Live and soak suites are manual or scheduled.

Agent Code exposes one stable required result named `quality-gate`. Package repositories call the reusable workflow through their `package` job, so GitHub exposes its final result as `package / quality-gate`. Branch protection MUST use that exact caller-qualified name; documenting only the inner reusable job name creates a required check that no workflow can satisfy.

## Delivery contract

Owned packages call the shared release workflow when a `v*` tag is pushed. The
tag MUST equal `v${package.json.version}`; the workflow reruns `check`, packs the
exact tagged source, and attaches the resulting `.tgz` to a GitHub Release.

WHY this does not publish to npm yet: these package names have never been
published, and `workflow-mcp` is private. Choosing public registry ownership and
access is a product/release decision, not a side effect of standardizing tests.
The GitHub Release is therefore the current continuous-delivery boundary. No
release job runs on an ordinary branch or pull request.
