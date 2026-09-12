# Agent names

A: settings registry/persistence, SessionMeta and existing replacement/rehydration
owners, shared AgentTitleHeader, DispatchAgentList, workspace observations and
cross-window agents.search are the trusted current surfaces. Titles describe tasks;
window-local coordinates currently provide spoken addresses that are awkward to say.

D: an opt-in Agent names toggle reveals stable, legible names from the approved
100-name list in headers/lists and exposes the same names for exact MCP discovery.
Names never silently target a different agent after close, replacement or restart.
No prompt, title, focus or layout is changed by enabling this feature.

## Stages

1. Durable name owner and setting.
   - Produces: shared ranked vocabulary/contracts; isolated main name registry
     with atomic persistence and serialized allocation; application IPC; default-off
     Agent names setting with normal coercion/registry support.
   - Verified by: concurrent-window allocation and reopen/corrupt-store tests;
     settings defaults/coercion. Allocation is committed before names are shown.
   - Why separate: renderer-local counters race across windows and reassign spoken
     addresses after restart. MCP must never own application identity.
   - Reality check: existing window-owned workspace persistence keeps its payload
     opaque, so registry storage is separate; SessionMeta carries only its durable
     naming identity, not a second copy of global allocation state.
2. Workspace identity and presentation.
   - Produces: one membership-driven reconciliation hook, lifecycle continuity,
     name selector/badge, shared header and Dispatch list integration.
   - Verified by: real-store toggle/assignment race checks, actual replacement
     hooks and header/list rendering. Names stay out of token-stream updates.
   - Why separate: presentation must consume one assignment, never mint on render.
   - Reality check: AgentTitleHeader is shared by structured/native providers;
     replacement changes local session IDs and explicitly reconstructs metadata.
3. External operator integration and verification.
   - Produces: enabled agentName fields in observations, exact name search and
     crash-course/skill instructions, reviewable feature PR with verification.
   - Verified by: real cross-window observation/search cases, disabled behavior,
     renderer/type/contract checks and an isolated visual preview where practical.
   - Why separate: spoken labels must resolve to current IDs/owners before effects;
     name lookup must not bypass existing ambiguity or ownership handling.
   - Reality check: existing agents.search returns all candidates and unavailable
     windows; mutations already require stable session identity.

## Isolation and decisions

The main name registry allocates unique names under a durable opaque identity;
only its application IPC adapter consumes it. Feature/UI/MCP code may not import
its persistence internals. A renderer reconciler claims missing identities after
workspace restoration; a shared selector reads names for all presentation/control
consumers. Membership/identity changes trigger reconciliation, not runtime tokens.
Assignments are retained when off and never automatically recycled. Pool overflow
uses explicit numeric suffixes. Duplicate/new agents receive new identities;
replacement/recovery/restore retain identity. Existing settings propagation remains
the app's setting contract; name reservations are process-wide across windows.

## Unknowns and evidence

Check metadata reconstruction during bulk reload and rehydration, related children
and buried records, windows moving sessions, assignment arriving after close or
replacement, disk failures, and narrow headers/rows. IPC failure must not fabricate
names or overwrite an unreadable registry. Main never parses workspace blobs for
naming. Corrupt/foreign metadata must not bypass provider/owner resolution.

Tests use real owner/store/registry paths and captured transition scenarios from
existing lifecycle tests, with fault injection only at IPC/disk/clock boundaries.
No live user workspace or provider is used for visual/testing probes.
