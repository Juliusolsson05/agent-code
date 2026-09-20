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
bug is invisible: the two cases were deliberately collapsed.

**The first attempt at this fix latched the peek instead, and was worse than
the bug.** A latched overlay owns every keystroke but Escape (useKeybinds'
input gate), so on exactly the machines #1066 is about, every ⌘L would have
swallowed all typing until Escape — the #1021 report, re-created.

The way out came from re-reading what is actually broken: **only the Cmd-LETTER
keyup is swallowed. The COMMAND keyup still reaches the renderer**, and the
controller already ends a hold on it. So a blind machine can still have a real
hold; it simply ends when the user releases Command rather than the letter.
Nothing latches, nothing owns input, and no escape hatch is needed.

What the user is owed on top of that is an EXPLANATION, which is the half of
the `dictation.hotkey.unavailable` precedent the first attempt missed:
`useDictationHotkeySync` journals in main *and* toasts in the renderer,
because "a packaged user never sees a console.warn".

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
- **Produces:** `exit(67)` from `--watch-release` when Command is not observable
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

### Stage 3 — the renderer keeps holding, and says why
- **Produces:** the controller's unobservable path — keep the gesture alive so
  the Command keyup ends it, and tell the app once so it can toast.
- **Verified by:** controller tests driving the PRODUCTION store transition,
  not an injected spy; a real-router test for the gesture already exists.
- **Why separate:** it is the only user-visible half, and it is where the
  never-stuck invariant is either kept or lost.

## Unknowns

- Whether `keyState` requires **Accessibility** specifically or **Input
  Monitoring**. This is no longer inferred: main corroborates the probe with
  `systemPreferences.isTrustedAccessibilityClient(false)`, which is prompt-free
  (a read-only pane preview must never raise a permission dialog) and answers
  the real question. Only a 67 the system agrees with is journalled or shown.
- Whether `keyState` blinds uniformly across keycodes. If modifiers stayed
  readable while letters did not, the probe would exit 0 and say nothing — the
  corroboration above is what keeps that from being silent, because the
  Accessibility state is observable on its own.
- A tap faster than the helper's own spawn (~20 ms measured) releases Command
  before the first poll and reports 67 on a healthy machine. The corroboration
  demotes that to an ordinary release, so it neither toasts nor writes a false
  permission claim into the debug bundle.

## Fixture plan

No recording is needed or possible here: the input is a live keyboard and a TCC
state, neither of which serializes. The real artifacts used instead are the
shipped binary's exit codes (Stage 1, observed directly) and a fake spawn at the
`watchMacTldrRelease` seam (Stage 2), which is the same seam its existing tests
use.
