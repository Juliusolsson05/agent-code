# The managed-runtime Electron check fails under load: a test-local 3 s startup deadline (#1334)

## Problem
`src/main/extensions/electron.system.test.ts` › "keeps one managed runtime across commands, view requests, updates and uninstall" failed once in a full local run under load, and passed alone. The failing run's error text was not captured.

## Evidence (reproduced; the machine's own load plus parallel harness runs)
- The test runs `scripts/check-extension-frames.mjs --runtime-only`. That bundles `src/main/extensions/testing/runtimeHarness.ts` and runs it in a hidden Electron app; alone it takes about 8.6 s, inside its 70 s budget.
- 12 parallel runs, with a temporary probe that logged the cold-command results:
  - **6 of 12 failed** at the first assertion, "bounded cold commands": `0 !== 32`.
  - All 40 cold calls were rejected with `Extension runtime did not finish starting before the deadline.` (and `Too many extension calls are pending.`).
  - The other 6 passed, logging 32 fulfilled.
- **Cause.** The harness constructs `ExtensionRuntimeService` with `startupTimeoutMs: 3000`, a test-local tightening of the product default of 10 s (`runtimeService.ts`). No assertion exercises a startup-deadline retirement. Under load, a COLD Electron activation takes longer than 3 s, so the runtime is retired and every queued cold command is rejected.

## Decision
Drop the harness's `startupTimeoutMs` override so the harness uses the product's startup deadline. This is not widening a budget to hide a failure: the 3 s value tested nothing, and it raced a cold Electron start.
- `invocationTimeoutMs: 1500` stays, because the stalled-engine case needs an invocation deadline that fires quickly.
- `until`'s 3 s poll budget was not observed failing in any run, so it is left as is.

## Verification
With the change, 24 of 24 parallel runs passed (two rounds of 12, load average about 40). Without it, 6 of 12 failed at the same load.
