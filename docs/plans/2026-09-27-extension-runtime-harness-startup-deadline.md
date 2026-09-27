# The managed-runtime Electron check fails under load: a test-local 3 s startup deadline (#1334)

## Problem
`src/main/extensions/electron.system.test.ts` › "keeps one managed runtime across commands, view requests, updates and uninstall" failed once in a full local run under load, and passed alone. The failing run's error text was not captured.

## Evidence (reproduced; the machine's own load plus parallel harness runs)
- The test runs `scripts/check-extension-frames.mjs --runtime-only`. That bundles `src/main/extensions/testing/runtimeHarness.ts` and runs it in a hidden Electron app; alone it takes about 8.6 s, inside its 70 s budget.
- 12 parallel runs, with a temporary probe that logged the cold-command results:
  - **6 of 12 failed** at the first assertion, "bounded cold commands": `0 !== 32`.
  - All 40 cold calls were rejected with `Extension runtime did not finish starting before the deadline.` (and `Too many extension calls are pending.`).
  - The other 6 passed, logging 32 fulfilled.
- **Cause.** The harness constructs `ExtensionRuntimeService` with `startupTimeoutMs: 3000`, a test-local tightening of the product default of 10 s (`runtimeService.ts`). (The `hung-engine` case does test a startup-deadline retirement; it now runs at the product's 10 s value, about 7 s slower.) Under load, a COLD Electron activation takes longer than 3 s, so the runtime is retired and every queued cold command is rejected.

## Decision
Drop the harness's `startupTimeoutMs` override so the harness uses the product's startup deadline. The 3 s value raced a cold Electron start in the bounded-cold case, where the deadline is not what is being tested. The deadline itself stays tested by `hung-engine`, at the product value.
- `invocationTimeoutMs: 1500` stays, because the stalled-engine case needs an invocation deadline that fires quickly.
- `until`'s 3 s poll budget was not observed failing in any run, so it is left as is.

## Verification
With the change, 24 of 24 parallel runs passed (two rounds of 12, load average about 40). Without it, 6 of 12 failed at the same load.

## Review a
- **A second load race.** The view case "close during an in-flight request" gated the request on an 80 ms sleep. Under 24-way load the sleep could end before the harness detached the view: 1 of 24 runs had a missing rejection. `slowIdentity` now waits for an explicit `releaseSlowIdentity` storage flag, which the harness sets only after the detach and the asserted rejection.
- **The comment said no assertion tests the startup deadline.** Wrong: `hung-engine` does. The comment and plan are corrected.
- **A third load race (found while verifying the second fix).** Under 24-way load, "updated startup runtime" timed out in 2 of 24 runs. That `until` wait includes a cold re-activation and had 3 s. `until` now takes a budget. The two waits that include an activation ("updated startup runtime", and "last command entered" after the stalled engine was destroyed) use `ACTIVATION_WAIT_MS`, which is the product's own startup deadline, now exported from `runtimeService.ts` as `EXTENSION_RUNTIME_STARTUP_TIMEOUT_MS`. Ordinary polls keep 3 s.
- **Verification after review a:** 48 of 48 runs at 24-way parallel load (load average up to 103). `src/main/extensions`: 23 files, 346 tests. `npx tsc -b` clean.
