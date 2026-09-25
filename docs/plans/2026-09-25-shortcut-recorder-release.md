# Shortcut recorder releases capture on outside click and window blur (#1272)

## Evidence
`CommandKeybindingsRow.tsx`: while recording, a capture-phase window keydown listener calls preventDefault and stopPropagation on every key. It releases only on Escape or a finished chord. `keybindingFromEvent` accepts a bare letter.

Sequence: click Add, then click the Settings search box, then type `t`. The key is swallowed and saved as that command's shortcut. The sibling recorders (`HotkeyInput`, `MouseButtonInput`) already release on an outside mousedown and on blur.

## Change
While recording, a mousedown outside the recorder's own button, or a window blur, ends the recording. This matches HotkeyInput.

## Tests
A renderer test on the real component with the real store. The first test clicks elsewhere and asserts that recording ended and that a typed `t` is neither swallowed nor saved. The second blurs the window. Both are red on main.
