# Extension runtime harness: count only runtime egress (#1187)

## Evidence
- **Reproduced locally under CPU load:** 2 of 10 runs of `node scripts/check-extension-frames.mjs --runtime-only` failed with exactly the issue's output.
- **Temporary request logging on the harness's egress server** showed one `GET /` in EVERY run, failing or passing, about 1.6 s after startup. Its headers were `user-agent: node`, `accept-language: *` and `sec-fetch-mode: cors`, which is Node's undici `fetch`, not the extension renderer.
- **Source:** the running Agent Code app's browser-pocket `LanePortWatcher` (`src/main/browserPocket/lanePortsIo.ts:45`, `probe(port)`) walks each agent lane's process tree, finds listening sockets with `lsof`, and probes them with `GET /`. The test ran inside an agent lane, so the harness's server is in that tree. Normally the probe lands after the egress assertion; under load it lands before.
- **The other two log lines are not the bug.** The `ZodError ... "extensionId"` is the harness's deliberate forgery probe (`runtimeHarness.ts`, the `sandbox` command expects `spoofDenied: true`). `No handler registered for 'extensions:runtime-api'` also appears twice in every passing run during disposal.

## Change
Every request that reaches the harness's egress server counts as runtime egress EXCEPT the watcher's exact shape, `GET /`, which is recorded and ignored.

**Superseded first version:** it counted only `/private-state` and ignored every other path. Review b showed that this would miss a leak to any other path (`/leak`, encoded or query variants).

**Positive control:** right after binding, main fetches both `/private-state` and `/egress-control`, and both must be counted before the journey starts (review c).

## Verification
- **Under load:** 0 of 10 runs fail with the fix; 2 of 10 failed before it.
- **Mutations, each failing the run:**
  - an "ignore everything" classifier fails the control;
  - excusing `/private-state` fails the control;
  - a main-side `GET /leak` after the control fails the egress assertion;
  - removing `will-navigate`, `will-frame-navigate` and the `webRequest` block fails the egress assertion.

**Residual:** a runtime escape that requests exactly `GET /` is excused. The renderer probes all target `/private-state`.
