# The palette chord works in an extension modal before its iframe has focus (#1307)

## Evidence (origin/main, found by #1300 review A)
- **Where focus sits.** When an extension modal opens, focus goes into the host shell, not the extension. Radix autofocuses the first tabbable element, which is the shell's close button while `viewBridge` keeps the iframe hidden until ready, and focus stays in the shell until the user clicks into the extension. (Review a corrected the first draft, which said `DialogContent` itself.)
- **Main forwards nothing.** `nativeInput.ts` forwards chords only when `contents.focusedFrame` is the extension's frame, and here the focused frame is the host.
- **The renderer drops the chord.** In `useKeybinds.ts`, the key targets the shell, not the iframe, so `extensionModal` is false. The app-ownership gate (the `DialogContent` carries the owner marker) then drops `open-command-palette`.
- **Same path for ⌘W.** It falls through to "prevent default and do nothing" instead of closing the modal.

## Change
- **One lookup.** `extensionModalFrameForTarget(target)` returns the modal iframe when the target is that iframe (the forwarded case). Otherwise it returns the modal iframe contained in the target's own app-owner element (the host-shell case), or null.
- **Both exemptions use it.** The ⌘W close and the palette exemption both go through this lookup. The close event is dispatched on the found iframe.
- **Scoped to the containing dialog.** A different owned surface stacked above the modal has no extension iframe inside it, so it keeps the gate.

## Tests (`focusModeKeyboardOwnership.renderer.test.tsx`, real `useKeybinds`)
All three use AppHostSurface's DOM shape: an owner-marked content element holding `iframe[data-extension-shell="modal"]`.
1. ⌘⇧P on the shell opens the palette. Red on main.
2. ⌘W on the shell fires `agent-code-extension-close` on the iframe, and invokes no command. Red on main.
3. Control: ⌘⇧P in an owned dialog without an extension frame stays dropped.
4. Review a: a dialog stacked above the extension modal keeps both chords. ⌘⇧P opens nothing, and ⌘W closes nothing. It kills the document-wide-lookup mutation that the first three survived.

## Not changed
- Focusing the iframe on load was the other direction in the issue. It would take focus from Radix's focus trap before the extension is ready, and it would not cover a user who has clicked the shell's chrome.
- The Electron journey test (#1300) waits for frame focus, so it still covers the forwarded path. This PR covers the host path.
