# Readable Codex tool steps in narrow lanes

## Evidence

Chromium reproduced the B25 screenshot with a 175 CSS-pixel card.
The tool name and trailing status cannot shrink; the argument gets zero width.
A paired duration ends outside the card. A 340-pixel card has space for the same call.
The exact-output disclosure works at both widths.

## Change

Allow the existing tool label, argument and outcome to move onto additional lines when needed.
Keep the glyph attached to the tool name. Preserve the compact row where space permits.

## Verification

Measure element and text bounds in Chromium at 175 and 340 CSS pixels.
Cover the paired call and the unpaired layout visible in the report.
Run the existing Codex script-step renderer tests and the focused layout regression.

## Results

The Chromium regression failed on the original row and passed after reflow.
At 175px the unpaired argument grew from 0px to 161px. The paired duration now
stays inside the card. At 340px the paired argument remains 108px in the same
single-line layout. The exact-output disclosure opened at 175px after the change.
