# Hold-to-peek: tell the user when the key cannot be observed

Implementation plan for #1066. Written before the code, per the repo's
convention that the plan is the first committed artifact on the branch.

## A — what exists and is trusted

- `native/macos-hotkey-helper/Sources/AgentVoiceHotkeyHelper/main.swift`, the
  `--watch-release <code>` branch: polls `CGEventSource.keyState` every 25 ms
  until the key is up or a 300 s deadline passes, then `exit(0)`. `exit(65)` on
  an unusable keycode.
- `src/main/tldr/holdRelease.ts` → `watchMacTldrRelease`: spawns that helper and
  calls `release()` on **any** exit or error.
- `src/main/tldr/ipc.ts`: owns one hold per sender, sends `tldr:hold-released`.
- `src/renderer/src/features/tldr/viewState.ts`: `createTldrHoldController` —
  `start` sets `held`, the native signal or a renderer keyup clears it.

Verified on the shipped 0.1.0 bundle: the helper is packaged under
`app.asar.unpacked`, signed with the Developer ID under hardened runtime,
verifies clean, and returns 0/65 correctly when run directly.

## D — observable end state

1. A hold whose key cannot be observed does **not** look like an instant
   release. The peek stays up, dismissible by Escape, instead of flashing.
2. The condition is recorded once per app run, the way
   `dictation.hotkey.unavailable` already is.
3. A genuine fast tap still releases, exactly as today.
4. `main.swift`'s claim that this path needs no Accessibility trust is corrected.

## The constraint that shapes everything

`holdRelease.ts` says it outright:

> Exiting because the key is up and failing to observe it both dismiss the
> hold. Never leave an opaque overlay stuck on a helper/packaging failure.

That is the right instinct (#1021's invisible-trap history), and it is why the
bug is invisible: the two cases were deliberately collapsed. So the fix must
separate them **without** reintroducing a stuck overlay. Latching is acceptable
where hanging is not: the latched state is the one `toggleTldr` produces every
day, Escape dismisses it, and the command toggles it off.

## The hard part: telling the two cases apart

`keyState` returns `false` both for "the key is up" and for "this process
cannot see the keyboard". Nothing distinguishes them **for the peeked key**.

The discriminator is the **modifier**. `observeTldrHoldRelease` starts a native
watcher only when `event.metaKey` is true, so at spawn time Command is
physically down. If `keyState` cannot see Command either, the API is blind —
that is a fact about the API, not about the user's fingers.

Rejected alternative: treat an implausibly fast exit (< ~100 ms) as
unobservable. It guesses from timing, so it would misfire on a genuine quick
tap and on a loaded machine, and it would still be wrong on a fast Mac where
the spawn itself costs 20-50 ms.

Residual false positive, accepted and bounded: the user releases Command
between the renderer's keydown and the helper's first poll. The renderer's own
keyup handler fires on that Command release (modifier keyups are **not**
swallowed the way Cmd-letter keyups are), so the hold is already over and the
late signal finds no gesture to act on.

## Stages

### Stage 1 — the helper reports which case it saw
- **Produces:** `exit(66)` from `--watch-release` when Command is not observable
  at the first poll; `exit(0)` unchanged for a real release.
- **Verified by:** running the packaged binary directly — 0 with no key held
  today, 65 on a bad code, 66 when Command reads as up.
- **Why separate:** it is the only layer that can see the keyboard, and it is a
  different language and build step from everything below.
- **Reality check:** the shipped 0.1.0 binary's observed exit codes.

### Stage 2 — main carries the distinction, and records it once
- **Produces:** `watchMacTldrRelease` passes the exit code to its caller;
  `ipc.ts` sends `tldr:hold-unobservable` instead of `tldr:hold-released` for
  66, and journals `tldr.hold.unobservable` once per app run.
- **Verified by:** unit tests over `watchMacTldrRelease` with a fake spawn.
- **Why separate:** the renderer must not learn exit codes; main translates.

### Stage 3 — the renderer latches instead of flashing
- **Produces:** the controller's `unobservable()` path — latch the preview
  rather than clear it, so it stays readable and Escape closes it.
- **Verified by:** controller tests; a real-router test already exists for the
  hold gesture (`tldr.renderer.test.tsx`).
- **Why separate:** it is the only user-visible half, and it must keep the
  never-stuck invariant.

## Unknowns

- Whether `keyState` requires **Accessibility** specifically or **Input
  Monitoring**. The web evidence points at Accessibility trust, and the owner's
  journal shows Accessibility denied for 0.1.0, but I could not proveethe exact
  TCC key from a shell. This does not change the fix: the code distinguishes
  *observable* from *not observable* and never names a permission it has not
  verified. The user-facing string says what to try, not what is certain.
- Whether a future macOS makes `keyState` require a grant it does not today.
  The same discriminator keeps working, because it asks the API about a key it
  knows is down.

## Fixture plan

No recording is needed or possible here: the input is a live keyboard and a TCC
state, neither of which serializes. The real artifacts used instead are the
shipped binary's exit codes (Stage 1, observed directly) and a fake spawn at the
`watchMacTldrRelease` seam (Stage 2), which is the same seam its existing tests
use.
