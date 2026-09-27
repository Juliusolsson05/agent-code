# Copy commands say when the clipboard refused (#1250 row 9)

Short plan: a bug with a known root cause. The row comes from `temp/quality-loop/hunt-c3.md` (row 9, P3). #1250 is a batch issue, so this PR is `Refs #1250`.

## Outcome
**Copy Last Response** shows "Copied to clipboard" only when the copy happened. When `navigator.clipboard.writeText` rejects (the document is not focused, or permission is denied), it says so in fixed words. The sibling **Copy Resume Command** failure shows fixed words, not the raw DOMException text.

## Root cause (verified in source, origin/main)
- `paneCommands.ts` `copy-last-assistant.run`: `void navigator.clipboard.writeText(text)`, then an unconditional "Copied to clipboard" toast. A rejection is an unhandled promise, and the toast lies.
- `sessionCommands.ts` `copy-resume-command.run`: catches, but renders `copy failed: ${err.message}` (raw browser text, q22).

## Design (contract)
- `copy-last-assistant.run` awaits the write. On success: "Copied to clipboard". On rejection: "Couldn't copy to the clipboard. Click into the app and try again."
  - Clipboard writes need a focused document; the palette or context menu can leave focus elsewhere.
- `copy-resume-command` uses the same failure sentence. The success toast is unchanged.
- The sentence is a constant: `CLIPBOARD_WRITE_FAILED` in `features/workspace/commands/clipboardFailure.ts`.

## Tests
New `paneCommands.copy.renderer.test.ts`. The runtime entries are the recorded bundle `testing/fixtures/rendering-bundles/2026-05-20T19-11-51-193-d4a44a16.json`; the clipboard is stubbed (the one edge).
- A rejecting write shows the failure sentence, never "Copied".
- A resolving write shows "Copied to clipboard".
- The resume command's rejection shows the fixed sentence, without the raw text.
- Red on main.

## Out of scope
- #1250's other rows.
- Debug-panel copy buttons (developer surfaces).

## Review round 1 (a, b: FIX-BEFORE-MERGE; c: MERGE-READY)
- **a1 (Major): a refused copy reports `ran` to `commands.run` callers.** Declined, with reasons:
  - Throwing would make `runGuarded` add its own "Command failed: Copy Last Response" toast, so every human path would get two messages for one failure.
  - The `commands.run` contract already says `ran` means only that the dispatcher returned, and tells the caller to observe the app afterwards.
- **a2 (Minor): nothing pinned that the command stays pending until the write settles.** Test added with a deferred write: the command is not settled and silent before the write, then says "Copied". It fails with a fire-and-forget `.then`.
- **b1 (Major): Browser Pocket's pick (no composer) swallowed a refused write and said "Element copied".** It now says the refusal. Test in `pick.renderer.test.ts`, red on the old pick.
- **b2 / c1 (Minor): the wording was compared against the constant only.** It is now asserted literally.
- **c2 (Minor): the assistant-message picker and the code-block picker said "Clipboard write failed".** Both now use the shared sentence. The constant moved to `lib/clipboardFailure.ts`, since four features share it.
