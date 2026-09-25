# Extension system test: the modal palette step presses before the modal owns focus (#1261, #1171)

## Evidence
CI run 36126927995 and three hits today (#1258, #1260, #1264):
- `palette access inside a real modal shell timed out` at electronHarness.ts:320.
- The "does not declare activation" line is expected output from the deliberate `assert.rejects` at :237.
- `nativeInput.ts` forwards a chord only when `contents.focusedFrame` is a direct agent-code-ext child. The step finds the frame with `frames.find(url startsWith agent-code-ext://managed/)`, which can still return the OLD pane frame while the modal replaces it (the test itself keeps `oldDocument` to prove stale documents are refused). It then focuses `body` in that frame and presses Ctrl+Shift+K without confirming Electron's focused frame.

## Change (test harness only)
- Pick the modal frame as the managed frame whose URL is not `oldDocument`.
- After focusing, wait (bounded, same 3 s budget and 20 ms step as `waitBindings`) until `win.webContents.focusedFrame` is that frame, then press.
No existing budget is widened.

## Verification
The system tier runs Electron, which this loop does not launch locally. CI is the check, and repeated green runs on this branch are the evidence.
