# Performance monitoring qualification

Date: 2026-09-12
Platform: macOS arm64, 8 logical CPUs, Node 25.5.0
Scope: implementation PR for #944/#956

This record separates deterministic bounds we can prove quickly from packaged
application measurements that require elapsed wall time or another architecture.
Synthetic time and projected bytes are never reported here as an 8-hour soak.

## Deterministic evidence

`npm run benchmark:monitoring` ran 100,000 strict record validations, bounded
queue admissions and histogram updates. It completed in 73.4435 ms elapsed and
62.456 ms process CPU. Per-record p50/p95/p99 were 0.250/0.584/1.458 µs. The
queue ended at 31 records / 15,872 bytes with no drops.

`npm run qualify:monitoring` simulated ten minutes of transport at the declared
2,306-record maximum process generation while deliberately flooding the normal
lane. All 120 process generations completed with zero process-record drops. The
normal lane shed 554,240 overload records as designed, and maximum accounted
queue plus batch bytes were 1,999,872, below the 2 MiB limit. A separate
100,000-span timer run measured 1.042 µs p99.

The retention projection contains 19,620 tiered points: 15 minutes at one
second, 24 hours at ten seconds and seven days at one minute. A representative
fully populated point projects to 8,260,020 bytes, below the 64 MiB operating
budget and the 134,217,728-byte hard ceiling. Runtime enforcement, atomic-file
headroom and cross-run pruning remain independent of this projection and are
covered by store tests.

## Packaged and fault evidence

The production utility-process entry is exercised by `npm run smoke:monitoring`
after `npm run build`. It launches Electron with an isolated temporary history
root and requires both an aggregated operation and a native process sample.
Three consecutive packaged-helper runs reported 71,237,632, 71,270,400 and
71,368,704 bytes RSS (67.94–68.06 MiB); a fourth experiment with a constrained
V8 old generation reported 71,417,856 bytes and was discarded because it did
not reduce the runtime floor while narrowing fault headroom. This is a stable
cold Electron/Node helper floor rather than retained monitoring payload.
The provisional 64 MiB total-RSS target was therefore revised explicitly to
80 MiB; the helper is still below that revised ceiling, but maximum-fleet and
long-running RSS remain pending rather than inferred from cold smoke.
Focused tests cover queue pressure, worker restart limits, malformed replies,
atomic process generations, renderer lifecycle, incident hysteresis, sleep and
visibility exclusions, corrupt history tails, bounded range queries, report
privacy, trace ownership, owner-close cancellation and shutdown history flush.

## Long-running evidence still required

The deterministic runner does not establish closed-monitor packaged CPU,
utility-process RSS, dashboard interaction delta, startup p95 or thermal behavior.
The 8-hour active workload, 24-hour disk
growth run, signed arm64 package and Intel Mac capability pass remain rollout
evidence to collect on dedicated machines. The implementation exposes queue
drops, collector restarts, worker RSS and local bytes so those runs can detect
observer overhead without enabling more telemetry.

No user transcripts, prompts, credentials, audio, environment, project paths or
heap contents were read for these measurements. Reports remain local files and
there is no report-sharing or upload implementation.
