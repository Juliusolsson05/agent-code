# GoalLoop "unrelated traffic cannot renew the screen grace" failed on main CI (#1314)

## Evidence

- Main CI run 36156560842 (merge `54287d90`) failed
  `src/main/goalLoop/GoalLoopService.test.ts:397` with 2 deliveries instead of 1. The same tree passed
  on the PR run, and locally the test passes when run alone.
- Instrumented locally (fake timers, real file store):
  - the first delivery happens at fake t = 45 s;
  - the traffic ticks at 60 s and 90 s open no hold;
  - the delivery run is still `continuing` at every later tick, with the 60 s turn boundary parked in
    `pendingContinue`.
- Why it stays `continuing`: after delivering, `maybeContinue` awaits `persist()`, which is **real disk
  I/O**. `vi.advanceTimersByTimeAsync` moves fake time forward without waiting for it, so the fake
  instant at which the parked trigger resumes depends on disk latency. That latency is the uncontrolled
  variable.
- **Deterministic reproduction:** the same test body with an instant in-memory store fails
  **3/3** with 2 deliveries. When persistence completes promptly, the 60 s boundary opens a fresh hold
  at 60 s and delivers at about 105 s, inside the test's 120 s window.

## Root cause

The test asserts "exactly one delivery in 120 s", but its own traffic contains a **legitimate second
turn boundary**. The `turn_started`/`turn_completed` pair at 60 s comes after our 45 s delivery, so it is
the delivered continuation's turn ending. A second continuation after another bounded 45 s grace is
correct behaviour. Whether that second continuation falls inside the window depends only on how long
the first delivery's real `persist()` takes relative to fake time: slow disk means 1 delivery (green),
prompt disk means 2 (red). That is why it failed on a loaded CI runner and passes locally.

This is a test bug, not a product bug:
- the product holds the screen grace for 45 s from the first hold;
- traffic during the hold (the 30 s tick) does not renew it;
- the first delivery lands at exactly 45 s.

That is the #1033 round-4 claim the test exists for.

## Decision (default)

Assert the claim, and only the claim:
- drive traffic **during** the hold, at 0 s and 30 s;
- check that nothing is delivered at 44.999 s;
- check that exactly one delivery happens at 45 s.

The test stops there, before any later turn boundary it does not mean to test. It runs against **both**
the real file store and an instant in-memory store, so persistence latency is pinned in both
directions. No timeout is widened, and no production code changes.

## Tests

- The rewritten case, parametrized over both stores.
- **Fail-first:** the old assertion window with the instant store is red 3/3 (reproduced above).
- **Mutation:** if held-progress traffic renewed `heldSince` (the bug #1033 round 4 fixed), the new test
  is red for both stores.
