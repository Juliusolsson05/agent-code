# Operation boundaries and incident evidence

Issue #956, stage 4 of #944, stacked on product monitor #955.

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
   and evidence details in the existing monitor. Stage 5 persists this schema.
4. Validate injected delays, cancelled/error outcomes, expiry and duplicate
   suppression, visibility/sleep cases, metadata allowlists and cardinality. Run
   typechecks/focused integration checks, then two independent MCP reviewers.
