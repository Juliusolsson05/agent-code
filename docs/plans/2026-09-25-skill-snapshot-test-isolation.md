# Plan: tests can never sweep the real skill snapshot store (#1206)

## Problem
`AgentCodeManagedSkillsService` takes the journal path (`stateFilePath`) and
the snapshot store (`installedSkillSnapshotRoot`) as two independent options.
The store defaults to the global `~/.config/agent-code/managed-skill-snapshots`.
Two system test files pass a temp `stateFilePath` but no snapshot root. Since
#1161, `initialize()` ends with a sweep of every snapshot the journal does not
reference. In those tests the journal is empty, so the sweep deleted the
developer's real snapshots. Every installed skill then showed **Degraded** with
raw `ENOENT … lstat` text, while the skills themselves kept loading from their
intact provider copies.

Confirmed by reproduction: with `HOME` pointed at a scratch dir holding one
valid snapshot, one run of `AgentCodeConventionsService.system.test.ts`
emptied it.

## Change
1. **Source fix, one funnel:** the default snapshot root is derived from the
   directory of the service's `stateFilePath`. The journal and the store it
   references are one unit. A journal sweeping a store it does not own is
   exactly the bug. In production `dirname(AGENT_CODE_CONVENTIONS_STATE_FILE)`
   is `STATE_DIR`, so the path is byte-identical and no migration is needed.
   The service was the only reader of the absolute
   `AGENT_CODE_INSTALLED_SKILL_SNAPSHOTS_DIR`, so it is replaced by a
   directory NAME constant. The separate `installedSkillSnapshotRoot` option
   is removed too (review finding: an explicit override could still pair a
   journal with a foreign store, and the reviewer reproduced the deletion
   through it). Nothing can pair a journal with a store it does not own.
2. **Readable failure:** when `verify`/`readFile` find the recorded snapshot
   missing, they report "Agent Code's reviewed copy of this skill is
   missing …" instead of the raw `lstat` errno. That covers the digest
   directory, the whole store and its parent. Nested directories and
   cleanup quarantines keep the raw error, because "missing from the store"
   would be false there. Snapshot corruption (a link, not a directory) keeps
   its existing message.
3. **Regression test** (system, real filesystem, real `initialize()`): a
   service built with only a temp `stateFilePath` sweeps an unreferenced
   snapshot beside that state file. The existing sweep tests already cover
   referenced snapshots surviving. A second test covers the readable message
   for both a missing digest directory and a missing store. On the unfixed
   code it fails because the sweep runs against the global root. The
   red run is executed with `HOME` pointed at a scratch dir, so proving the
   test cannot itself destroy real data.

## Not in scope
- Self-healing a missing snapshot from byte-identical provider copies. That
  is a real recovery feature, with trust questions of its own (provider copies
  are generated artifacts that are never imported back). If wanted, it gets
  its own issue.
- Other test/real-state leaks. A read-only audit of every `storage/paths.ts`
  constant against its tests found none that are live. Two are fragile but
  non-destructive and are listed in the PR: the extension GitHub-auth
  install tests stay off disk only because their stubbed API errors first,
  and `AppRunJournal.completeness.test.ts` leaves the rename/writeFileSync
  paths unmocked.

## Verification
`npx tsc -b`, the agentCodeConventions system tests, then the full suite once.
The reverted-fix red run is recorded in the PR.
