# MCP reload preferences and TLDR freshness

Issue: #904

## Intended behavior

Global built-in MCP preferences apply on each new provider process, including
reloads of existing agents. Changing Settings does not interrupt live work.
Persist explicit per-domain overrides separately from the active capability
snapshot; provide a session command to return to global preferences. Preserve
explicit MCP lists from agent-creation callers and provider capability filters.
Legacy enabled domains become explicit on; legacy absent domains inherit because
old snapshots cannot distinguish inherited off from a deliberate per-agent off.

TLDR retains centered white summary text over its dark pane, with a small muted
footer: Last active and Note written. Activity comes from provider runtime/
transcript evidence, independent of TLDR writes. Recent times use readable
relative units; beyond 30 days use a local calendar date. Exact local timestamps
remain accessible. Unknown activity is honest; active work says Active now.

## Implementation sequence

1. Add shared preference normalization/resolution, retain effective snapshots,
   and thread overrides through spawn/replacement/recovery/provider handoff/undo.
2. Update session commands and Settings copy, with explicit reset-to-defaults;
   retain skill reconciliation before every TLDR-enabled provider launch.
3. Add TLDR activity derivation and time formatting; render a bounded footer
   that updates only while preview is visible and preserves pane ownership.
4. Add regression tests for actual reloads after global changes, override and
   migration precedence, live-backend adoption, per-pane activity and independent
   note timestamps, relative/date boundaries and timer cleanup.
5. Run focused tests, type checking, keybinding/contract gates and CI; inspect
   final diff and hidden/offscreen UI output, then open the follow-up PR.

## Constraints

No visible probe apps. No unrelated MCP transport or provider changes. Global
settings describe desired next-launch behavior; live capability snapshots remain
authoritative for current UI. Keep WHY decisions inline and preserve summary
identity only for the same conversation. Do not merge without authorization for
this follow-up PR.
