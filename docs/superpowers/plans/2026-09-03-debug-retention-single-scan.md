# Storage: prune debug retention from one scan

Fixes #728. Refs #103, #372.

## Problem

`pruneDebugStorage` runs every five minutes for the life of the process
(`performanceLog.ts` schedules it on every perf flush). Each run calls
`collectArtifacts()` three times — once per pass (TTL, per-bucket cap,
global budget) — and each call re-reads and re-parses the 18 MB / 45k-line
debug-bundle ledger and re-stats ~2,200 files, all on the main thread:
roughly 136k `JSON.parse` calls, ~6,500 `stat` round-trips and hundreds of
milliseconds of CPU per prune, twelve times an hour.

## Design

Scan once, then run the three passes over that list, dropping each removed
artifact from the working set as it goes:

- `collectArtifacts()` is called once per prune.
- A new `runPrunePasses(artifacts, policy, remove)` holds the pass logic
  (TTL → per-bucket cap → global budget) over an in-memory live set. Its
  byte accounting is what the old code did between re-scans — subtract the
  bytes `removeArtifact` reports — so the pass outcomes are unchanged.
- `pruneDebugStorage` becomes policy resolution + one collect + the passes.

Pulling the passes into a function that takes the artifact list and the
remover makes the pass semantics unit-testable without touching disk,
which the module never had.

Not in scope: the proxy bucket exceeding its cap because live Codex runs
sit inside `ACTIVE_GRACE_MS` and single runs reach multiple GB. That needs
a per-run capture cap in codex-headless.

## Review follow-ups (applied)

- The comment now states what one scan trades away (bytes/mtime snapshot,
  files created or removed mid-prune) and why that is acceptable.
- `remove` answers a boolean; the passes account the artifact's collected
  bytes, so accounting cannot drift between passes.
- The cap and budget tests are constructed so the protected and active
  artifacts are actually reached while still over cap/budget.

## Verification

- New tests for `runPrunePasses` with in-memory artifacts and a recording
  remover: TTL removes only stale unprotected artifacts; the cap pass
  trims the oldest inactive artifacts of an over-cap bucket and, while
  still over cap, skips protected and active artifacts and never caps the
  manual bucket; the budget pass trims oldest-first until under budget with
  the same exemptions; an artifact removed by one pass is never offered to a
  later pass; a failed removal is neither counted nor dropped; result totals
  match. "One `collectArtifacts()` per prune" itself is not pinned by a test
  (it would need fs mocking); it is a one-line property of
  `pruneDebugStorage` visible in the diff.
- Existing `collectSessionRecordingDirs` tests unchanged.
- `npx tsc -p tsconfig.node.json --noEmit`.
