# Performance Monitor overview rebuild

Issue #984, part of #944. Stacked on the monitor shipped in #951/#953.

1. Keep 15 minutes of per-agent memory and CPU in main, derived from the
   cached process pages the monitor already reads (new `AgentUsageHistory`).
   Attribution: a process owned by exactly one session counts toward that
   agent (children included); a process shared by several sessions counts once
   as shared; app/agents/terminals/shared/other always sum to the total.
   Served read-only from main via `performance:monitor-agents`, so it never
   waits on the helper.
2. Shared chart components (`components/charts`) used by both the monitor and
   Agent Analytics: interactive time-series (real pixel axes with rounded
   ceilings, lines that break at gaps, a crosshair that snaps to real samples,
   shared across charts that measure the same window, thresholds, incident
   markers, full keyboard + screen-reader readout), nested bars and sparklines
   on a shared scale. Pure geometry split into tested `chartMath`.
3. Rebuild the monitor Overview as answers in reading order: totals strip
   (memory with share of RAM and 15-min delta, CPU, heaviest agent, running
   counts, UI responsiveness, heap, incidents — toned with the incident
   engine's own thresholds), stacked memory/CPU charts with one crosshair,
   then "Agents by resource use": every running session under its workspace
   label (A15) with memory share, signed growth, CPU, process count and a
   sparkline; sortable by memory/CPU/growth; "Go to" wakes, focuses and
   closes only when navigation succeeds.
4. Move Timeline onto the same charts (memory/CPU/responsiveness lanes,
   1h/6h ranges, Earlier/Later panning, markers that select their incident)
   and show agent labels + titles in the Processes table instead of session
   ID prefixes.
5. Put Agent Analytics on the shared charts: per-day bars with wall-clock
   nested inside agent-hours, parallelism tile, per-project share bars.
6. Delete the two superseded debug surfaces — the old Performance panel
   (`features/performance`, endpoint `performance:pane-stats`) and the System
   performance badge/popover (`features/system-perf`, endpoint
   `performance:system-stats`) — moving the "performance" feature-reference
   page to the monitor directory that now owns those commands.

Out of scope: drag-to-zoom on the timeline (follow-up), longer/persistent
per-agent history windows.

Implementation evidence: attribution, chart-geometry, label-resolution and
chart-interaction tests pass (vitest); full `tsc -b` clean. Monitor lifecycle
tests unchanged and passing; feature-reference coverage updated for the
removed directories.
