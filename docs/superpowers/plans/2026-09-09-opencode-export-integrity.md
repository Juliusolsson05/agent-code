# OpenCode Export Integrity

Refs #845. Independent detour from Grok integration; no merge is authorized.

The affected OpenCode 1.18.30 session exported invalid 65,536-byte piped stdout
but valid 14,566,990-byte file output with 804 messages and matching identity.
The installed-version source writes stdout without awaiting it, then calls
process.exit() in its CLI finally block. This is producer-side pipe truncation,
not Agent Code's 256 MiB buffer limit or a provider-specific translator bug.
The private probe exported read-only, reported metadata only, and deleted output.

1. Add a real child-process regression that writes a large native-shaped JSON
   export and exits immediately, plus genuine-invalid-JSON and command-failure
   cases. Use synthetic text in the transport stimulus, never personal prompts.
2. Capture finite OpenCode CLI stdout directly into a private temporary regular
   file, not an asynchronous pipe. Keep process execution shell-free; wait for
   completion before reading; preserve bounded output/error handling and cleanup.
   Apply at the shared CLI boundary so large resolved config output is protected
   too, not just outbound session export. Do not repair JSON or repeatedly export.
3. Run switching/CLI integration tests and typecheck. Re-run the affected native
   export through the fixed production API and report only size/identity/counts.
4. Read-only review, fix verified findings, publish a focused PR linked to #845.
   No Grok changes, app launch, source-session mutation, or automatic merge.

## Verification

The large abrupt-exit export and config regressions failed at 65,536 bytes with
the old pipe transport. The regular-file capture passes both. Coverage also
exercises import/model compatibility, private permissions, cleanup, actual
spawn failure, nonzero exit, invalid JSON, sparse oversized output and bounded
stderr. Read-only review identified post-spawn error handling that could retire
capture ownership before close; a failing lifecycle regression reproduced it.
Errors are now recorded and settled at close, including failed-spawn close.

The actual affected session passed the opted-in production export test without
printing or retaining its contents. The 256 MiB final-size check is a memory
bound; polling detects disk overflow during execution but is not a hard quota.
Versioned upstream evidence: anomalyco/opencode v1.18.30,
packages/opencode/src/cli/cmd/export.ts and packages/opencode/src/index.ts.

## Merge with main (e9ac8bdf)

Main's e9ac8bdf (Refs #864) had meanwhile bounded every CLI call with
execFile's `timeout` plus an owned abort listener, both SIGKILL, with a 30 s
default, so a hung empty-session import cannot hold OpenCode Terminal startup
or survive stop(). The merge (36bf9581) rebuilt both bounds by hand on
`spawn` and kept main's invariants: settle only from `close`, cancellation
wins over timeout or overflow, and an already-stopped caller creates nothing.
Timeout errors now read `timed out after N ms` instead of execFile's
`Command failed: ...`.

## Review round (2026-09-12)

Two independent reviews of the merged head (Codex: request changes; Claude:
approve with comments) led to these changes:

- A spawn that fails before stdio exists (EMFILE/ENFILE) has no stderr stream.
  The `child.stderr!` dereference ran before the lifecycle listeners, so the
  next-tick child `error` became an uncaught exception, which the crash hooks
  turn into an app exit. The listeners now come first and stderr is optional.
- Every kill path SIGKILLed only the direct child. OpenCode's npm launcher
  spawns the native binary with inherited stdio and cannot forward SIGKILL, so
  the native process kept the capture and stderr pipe open, and timeout, stop
  and overflow never settled. The merge had also dropped execFile's stdio
  destruction. Commands now run in a private process group on POSIX, and one
  terminate() destroys stderr and then SIGKILLs the group. Resolving the native
  binary was rejected: it would couple Agent Code to OpenCode's install layout
  and still miss helpers a native CLI starts itself.
- The capture was removed only by an async finally, which an app quit does not
  await. It is now unlinked, with its directory, before spawn and read through
  the retained descriptor with positional reads, because the child moved the
  shared offset. The import payload is still read by path and is out of scope.
- Transform export and import inherited the 30 s startup default. They now
  pass 5 minutes, while the startup import and profile probes keep 30 s. The
  14.6 MB export's duration was never measured and was not measured in this
  round, because no live run against real sessions was authorized. Transforms
  carry no AbortSignal, so the deadline is their only bound.
- Declined: an app-wide shutdown drain for finite CLI operations. With the
  unlink, nothing persists across a quit. An orphaned child on quit predates
  this branch (execFile had the same exposure). An app-owned operation drain
  belongs to the quit lifecycle and operation ownership work in #919 and #918.
- The comments no longer claim that `spawn` lacks `timeout`/`killSignal`.
  Spawn failure must now report ENOENT, and the late-stop replay is covered.

Regression evidence: real two-process launcher trees for timeout, stop,
overflow, and a descendant that left the group; a spawn-failure double without
stderr that errors on the next tick; a zero link count observed inside the
running child; and no named capture while an import child runs. With its fix
reverted, each regression failed for the expected reason: an uncaught EMFILE,
a call still pending past its bound, a surviving descendant, a link count of 1,
or a named capture directory.

## Review round 2 (2026-09-12)

Both reviewers re-checked 8c94da7e (Codex: request changes; Claude: approve
with comments). Every round-1 disposition held. Changes:

- terminate() could signal a released process-group id. Node reaps the direct
  child before `exit`, but `close` also waits for stderr EOF, so the deadline,
  stop() and the size guard stay armed after the reap while an escaped helper
  holds stderr, and by then the group id is free for reuse. A timeout or
  overflow followed by stop() also signalled twice. The group is now signalled
  at most once, and only while exitCode and signalCode are both null. After
  the reap, terminate() only destroys stderr, which is enough to release
  `close`. Trade-off: a same-group member that outlives an exited leader is no
  longer killed. It can only append to the unlinked capture, and readCapture
  is bounded by the fstat size. The npm launcher waits for its native child,
  so the tree the group exists for is unaffected.
- The launcher-tree tests armed a 2 s deadline at spawn but allowed 5 s for
  fixture readiness, and read the launcher pid from a possibly reparented
  ppid. A failed readiness wait also left unobserved trees running. The tests
  now live in opencodeCliSessions.processTree.system.test.ts behind a spawn
  seam that returns only after the fixture reports, so readiness precedes
  every bound and the bounds stay tight. The launcher passes its own pid, the
  test owns the launcher's ChildProcess from spawn, and cleanup aborts the
  command before awaiting it.
- The detached-group comment said a wedged child runs "to the deadline". The
  deadline is a timer in Agent Code's main process and ends with it, so a
  dev-terminal Ctrl+C that kills Electron leaves a wedged CLI unbounded.

Round-2 regression evidence, each with its fix reverted:
- Signalling after the reap: the reaped-leader case fails with a recorded
  negative-pid SIGKILL.
- Removing the once-only guard: the timeout-then-stop case records two group
  signals.
- The round-1 kill-path mutations still fail the moved tree tests:
  - direct-child kill only: all six cases pending past their bound;
  - no stderr destroy: both escaped-helper cases pending;
  - no group kill: descendants survive, or the timeout-then-stop case never
    triggers its stop.
