# Complete performance evidence and profiling

Issue #956, consolidated stages 4–6 of #944, following merged product monitor
#955. The user requested one substantial shipping PR for the remaining system.

1. Add cheap monotonic operation timers with finite names/outcomes and bounded,
   expiring correlation. Instrument real main/preload/renderer boundaries for
   startup, sessions/prompts, IPC, transcript handling, terminal writes,
   persistence, worktree refresh, orchestration and dictation. Never retain the
   operation arguments or derive metric names from dynamic content.
2. Detect main stalls, visible-renderer stalls, repeated long tasks, memory
   pressure and slow local operations in the helper. Preserve observed signals
   and threshold explanations rather than inventing causal attribution. Provider
   waits and hidden/sleep intervals are distinct from local slowness.
3. Retain bounded 60-second pre/15-second post numeric context per incident,
   cap incident count/bytes, and apply hysteresis/cooldown. Expose incident list
   and evidence details in the existing monitor.
4. Persist 15-minute/24-hour/7-day numeric tiers in the utility process under a
   hard automatic budget. Support bounded full-range timeline queries, corrupt
   tail recovery, local-only content-minimized reports and explicit clear.
5. Add separately initiated Chromium traces, main-process CPU profiles and heap
   snapshots with app-wide ownership, native destinations, warnings, deadlines,
   disk/artifact limits and owner-close/quit cancellation. Baseline monitoring
   never starts an advanced capture.
6. Validate injected delays, cancelled/error outcomes, expiry and duplicate
   suppression, visibility/sleep cases, metadata allowlists and cardinality. Run
   typechecks, build, utility-process smoke, deterministic overload/retention
   qualification, then two independent MCP reviewers on the combined final diff.
