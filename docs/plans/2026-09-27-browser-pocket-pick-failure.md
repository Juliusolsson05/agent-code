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
