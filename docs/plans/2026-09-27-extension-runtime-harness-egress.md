# Extension runtime harness: count only runtime egress (#1187)

## Evidence
- **Reproduced locally under CPU load:** 2 of 10 runs of `node scripts/check-extension-frames.mjs --runtime-only` failed with exactly the issue's output.
- **Temporary request logging on the harness's egress server** showed one `GET /` in EVERY run, failing or passing, about 1.6 s after startup. Its headers were `user-agent: node`, `accept-language: *` and `sec-fetch-mode: cors`, which is Node's undici `fetch`, not the extension renderer.
- **Source:** the running Agent Code app's browser-pocket `LanePortWatcher` (`src/main/browserPocket/lanePortsIo.ts:45`, `probe(port)`) walks each agent lane's process tree, finds listening sockets with `lsof`, and probes them with `GET /`. The test ran inside an agent lane, so the harness's server is in that tree. Normally the probe lands after the egress assertion; under load it lands before.
- **The other two log lines are not the bug.** The `ZodError ... "extensionId"` is the harness's deliberate forgery probe (`runtimeHarness.ts`, the `sandbox` command expects `spoofDenied: true`). `No handler registered for 'extensions:runtime-api'` also appears twice in every passing run during disposal.

## Change
Every renderer egress probe (fetch, window.open, navigation) targets `/private-state`. The harness now counts only requests for that path as egress. Anything else is recorded as foreign, ignored, and named in the assertion message.

## Verification
- 0 of 10 runs fail under the same load.
- A mutant that removes `will-navigate`, `will-frame-navigate` and the `webRequest` block still fails the egress assertion (foreign list empty), so the filter did not blind the check.
