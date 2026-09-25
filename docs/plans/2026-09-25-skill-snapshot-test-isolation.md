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
   The global constant stays for its other readers but is no longer the
   service's fallback.
2. **Readable failure:** a missing snapshot directory reports "Agent Code's
   reviewed copy of this skill is missing …" instead of the raw `lstat` errno
   string. Snapshot corruption (a link, not a directory) keeps its existing
   message.
3. **Regression test** (system, real filesystem, real `initialize()`): a
   service built with only a temp `stateFilePath` sweeps an unreferenced
   snapshot beside that state file, and a referenced one survives. On the
   unfixed code it fails because the sweep runs against the global root. The
   red run is executed with `HOME` pointed at a scratch dir, so proving the
   test cannot itself destroy real data.

## Not in scope
- Self-healing a missing snapshot from byte-identical provider copies. That
  is a real recovery feature, with trust questions of its own (provider copies
  are generated artifacts that are never imported back). If wanted, it gets
  its own issue.
- Other test/real-state leaks the audit may find. Fixed here only when they
  are the same pattern (a destructive default path) inside this blast radius.
  Anything else gets its own issue.

## Verification
`npx tsc -b`, the agentCodeConventions system tests, then the full suite once.
The reverted-fix red run is recorded in the PR.
