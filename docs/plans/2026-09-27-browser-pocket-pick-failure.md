# Browser Pocket Pick says why it failed (#1305)

Short plan: a bug with a known root cause (#1305, class C3, P3). Fixes #1305.

## Outcome
Pressing Pick in a lane's browser pocket either picks an element, is cancelled by the user, or fails with a reason the user can read. Today every failure looks like a cancel: nothing happens. That includes DevTools open on the pocket (the debugger cannot attach), any CDP error, and the feature being disabled.

## Root cause (verified in source, origin/main)
- `BrowserPocketController.pick` answers `null` for no pocket and for a disabled feature, and `job.catch(() => null)` turns every thrown error into `null`.
- `pick.ts` (`pickIntoComposer`) treats `null` as "the user cancelled" and returns silently. An IPC rejection is caught into `null` too.
- `pickElement` answers `null` for a genuine cancel (Esc, the ◎ again, a second pick, the 60 s timeout).

## Design (contract)
- **`@shared/browserPocket/types`:** `PocketPickOutcome = { kind: 'picked'; result: PocketPickResult } | { kind: 'cancelled' } | { kind: 'failed'; reason: 'devtools-open' | 'unavailable' | 'error' }`.
- **`BrowserPocketController.pick(): Promise<PocketPickOutcome>`:**
  - no pocket, or the feature disabled: `failed / unavailable`;
  - DevTools open on the pocket, checked before attaching (as the agent gate already does), and again when classifying an error: `failed / devtools-open`;
  - any other thrown error: `failed / error` (the raw error is warned in main);
  - `pickElement` answering null: `cancelled`.
- **IPC and preload** carry the outcome through unchanged.
- **`pickIntoComposer`:**
  - `cancelled` stays silent;
  - each `failed` reason shows a fixed toast (q22);
  - an IPC rejection shows the `error` sentence.
  - Sentences: devtools-open "Close the pocket's DevTools to pick an element."; unavailable "The browser pocket isn't available for picking right now."; error "Couldn't pick an element. Try again."

## Tests
- **`BrowserPocketController.test.ts`** (the existing fake guest/debugger harness):
  - DevTools open gives `devtools-open` and never arms the overlay;
  - an attach that throws gives `error`;
  - a disabled feature and an unknown pocket give `unavailable`;
  - the existing queued-cancel test expects `cancelled`.
  - Red on main (null for all).
- **`pick.renderer.test.ts`:** each failed reason shows its sentence; a cancel says nothing; an IPC rejection shows the error sentence.

## Out of scope
- The pick timeout length. The clipboard branch of `pick.ts` is fixed separately in #1421 (same file, different lines).

## Review round 1, reviewer a (FIX-BEFORE-MERGE)
- **a1: a pick ended by the lifecycle read as the user's cancel.** Examples: the feature switched off while it waited in the queue, a reset, or the guest going away. The abort now carries a failure reason; `detach` passes `unavailable`, and only a reasonless abort (the user's cancel, or a second pick replacing the first) is `cancelled`.
- **a2: the DevTools precheck left an earlier armed pick pending for its 60 s.** The precheck now settles it first, with `devtools-open`.
- **a3: a pick cancelled in the queue kept its abort handle.** The early return now sits inside the `try`, so the `finally` clears it.
- Each is pinned by a test that fails on the previous head.

## Review round 1, reviewers b and c (FIX-BEFORE-MERGE)
- **b: an abort during node resolution was ignored.** After the node is chosen, the picker resolves it through more CDP calls with no abort hook, so a cancel then still inserted a chip, and a switch-off answered `picked` (or `error` if the call rejected). The abort now wins over whatever the pick produced, on both the resolve and the reject path.
- **c1: a guest destroyed mid-pick left it armed for 60 s** (no cancel could reach it once the pocket left the map), then a silent cancel. `forget` now settles it as `unavailable`. The a1 addendum claimed this case; it is now implemented and pinned.
- **c2–c5 (test gaps):**
  - a completed pick answers `picked`, driven through the real picker with Chromium-shaped CDP answers;
  - a pick REJECTED while DevTools opened says `devtools-open`;
  - the first abort's reason wins over a later cancel;
  - the main-side warn is asserted.

## Verification (a, b: FIX-BEFORE-MERGE, minor)
- **a1 / b1: a later lifecycle abort overwrote an earlier user cancel.** A cancel followed by a switch-off showed an "unavailable" toast for a cancelled pick. The FIRST abort now latches the outcome in either order. Test red on the previous head.
- **a2: the abort-wins rule was untested when node resolution REJECTS.** Pinned: a switch-off during resolution, then a rejected CDP call, answers `unavailable`. Removing `aborted_()` from the rejection mapper now fails it.
