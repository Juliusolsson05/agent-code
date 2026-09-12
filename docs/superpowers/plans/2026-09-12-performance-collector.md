# Shared performance collector

Issue: #950. Parent feature: #944. Depends on contracts PR #949.

1. Introduce one main probe owner with cached memory and event-loop windows;
   reuse those values in incident, legacy performance, and system-stat readers.
2. Build a utility-process collector with bounded messages, acknowledgements,
   one request in flight, explicit timeouts, capped restart attempts and typed
   live snapshots. Electron APIs remain in main; aggregation runs in the helper.
3. Extend the existing renderer heartbeat owner with safe observations and
   teardown. Main derives sender identity and bounds input. Stop whole-document
   diagnostic counts during baseline operation and remove duplicate observers.
4. Preserve crash/run identity and fatal evidence, while making automated heap
   pressure capture metadata-only. Detailed snapshots require an explicit action.
5. Add cached IPC for the upcoming UI, and a packaged helper entry/smoke harness.
   Keep baseline activation separate from legacy verbose mode.

Verification: unit and system tests for lifecycle, backpressure, worker failure,
sender validation and clock windows; existing incident/heap regression suites;
typecheck/build plus isolated Electron helper smoke and resource measurements.
Hardware-specific and long-duration evidence will be reported separately.

Implementation status: shared main probe, bounded utility-process coordinator and
aggregator, renderer singleton/disposal and acknowledged heartbeat transport,
cached IPC, and metadata-only heap pressure are implemented. Thirteen focused
unit/renderer tests pass, full main+renderer TypeScript checking passes, and the
isolated real Electron helper smoke passes. Initial helper RSS was 69,746,688
bytes (~66.5 MiB), above the provisional 64 MiB budget; stage 6 must qualify
fixed helper overhead and incremental retained evidence rather than claiming
this target already passes. Live snapshot queries carry the last 120 main
points; the worker retains the full 15-minute ring for later history queries.
Full build and independent review remain in progress.
