# Extension system test: the modal palette step presses before the modal owns focus (#1261, #1171)

## Evidence
CI run 36126927995 and three hits today (#1258, #1260, #1264):
- `palette access inside a real modal shell timed out` at electronHarness.ts:320.
- The "does not declare activation" line is expected output from the deliberate `assert.rejects` at :237.
- `nativeInput.ts` forwards a chord only when `contents.focusedFrame` is a direct agent-code-ext child. The step focused the modal's `body` and pressed Ctrl+Shift+K straight away, without confirming that Electron's focused frame had moved. On a slow runner, under Radix's own focus handling, it had not yet moved, so the chord was dropped.
- **Corrected after review (#1300 round 1 C, round 2 A):** the first draft blamed frame selection, on the theory that `frames.find(...)` could return the OLD pane frame. It can't. The fixture unmounts the pane before mounting the modal, so only one managed frame exists at that point. The real race is focus propagation.

## Change (test harness only)
- One `focusFrame(frame)` helper, used by both the pane step and the modal step. It focuses the frame's body, then waits (bounded by the same 3 s budget and 20 ms step as `waitBindings`) until `win.webContents.focusedFrame` is that frame, compared by `processId` + `routingId` rather than wrapper identity. Only then does the step press.
- Excluding `oldDocument` when picking the modal frame is kept, but only as a defence.
No existing budget is widened.

**Product gap, filed separately as #1307:** in the real app, an extension modal's palette chord does nothing until the user clicks into the iframe. Nothing focuses a modal iframe once it becomes ready. The harness focuses the frame explicitly, so this journey does not cover that path.

## Verification
The system tier runs Electron, which this loop does not launch locally. CI is the check, and repeated green runs on this branch are the evidence.
