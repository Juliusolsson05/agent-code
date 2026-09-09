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
