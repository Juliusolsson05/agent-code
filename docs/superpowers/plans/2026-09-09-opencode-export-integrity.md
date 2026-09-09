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
