# Composer: never forward Tab to the provider; give the occupied composer a keyboard way out

Fixes #737. Refs #683, #679, #174.

## Problem

The normal-mode composer forwards a bare `\t` to the PTY on every Tab
press. Claude Code treats Tab on an empty input with a prompt suggestion
showing as "accept suggestion": the dim placeholder becomes real input, the
headless composer classifier reports `drafted`, the prompt gate latches
`occupied`, and every send is refused with "prompt input is occupied by a
human draft". Because `inputReady` is now false, Escape / Ctrl+C / Ctrl+U
from the app composer are also blocked, so the user has no keyboard way to
clear the text that is blocking them.

## Design

1. Tab never reaches the PTY from normal mode. The provider composer is
   empty by construction while the draft lives in the textarea, so the only
   things a forwarded Tab can do in Claude are accept the suggestion (the
   bug) or show a hint. Slash-mode Tab (picker completion) is unchanged.
   Tab on an empty app draft with a suggestion chip present accepts the
   chip into the textarea — the same gesture Claude offers, but where send
   actually works. Shift/Ctrl/Alt/Meta+Tab do nothing.
2. When the pane is blocked on `composer-occupied`, Escape from the app
   composer runs the same clear routine as the "Clear Agent Composer"
   palette command (spaced Ctrl+U presses — never ESC, which interrupts a
   running turn). The routine moves into a shared helper so the palette
   command and the keybind cannot drift.

No change to the readiness gate, the classifier, or delivery.

## Verification

- New renderer test for `useComposerKeybinds`: Tab with an empty draft and
  a suggestion accepts the chip and sends nothing; Tab with a draft sends
  nothing; Shift+Tab sends nothing; slash-mode Tab still forwards `\t`;
  Escape while `composer-occupied` sends spaced Ctrl+U rather than the
  "still starting" toast; Escape when ready still sends ESC.
- `npx tsc -b`.
