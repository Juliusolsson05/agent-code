# Performance Monitor and process attribution

Issue #951, part of #944. Stacked on collector PR #953.

1. Add one process sampler for all Electron and managed-session processes, with
   bounded topology discovery, no overlapping native commands, timestamped CPU
   deltas and `(pid, creationTime)` identities. Deduplicate shared descendants;
   distinguish unavailable values, activity hints, and approximate summed RSS.
2. Make existing pane and freeze diagnostics read the same cached process data.
   UI reads must never trigger native scans or reset CPU intervals.
3. Introduce one accessible Performance Monitor dialog with overview, bounded
   charts, window health, a sortable/paged process table and operation summaries.
   Poll only while mounted, with one request in flight and stale/error states.
4. Add Settings → Performance and promote the existing performance command to
   the ordinary palette, retaining its ID for saved bindings. Replace the two
   competing debug header surfaces with this shared monitor.
5. Test attribution/dedup/PID reuse, sampling overlap, polling teardown and normal
   settings/command discovery. Typecheck/build and inspect the real UI before
   two independent Agent Code orchestration reviews. History, incidents and
   explicit captures are subsequent stages of the full monitoring plan.
