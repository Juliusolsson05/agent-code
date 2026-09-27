# Pasting an image into an agent that cannot take one says so (#1250 row 7)

Short plan: a bug with a known root cause. The row comes from `temp/quality-loop/hunt-c3.md` (row 7, P3). #1250 is a batch issue, so this PR is `Refs #1250`.

## Outcome
Only Claude takes pasted images today (`supportsImageAttachments`). In a Codex, OpenCode, Grok or Pi composer, pasting a screenshot does nothing at all. The user now sees "<Provider> can't take pasted images." when the clipboard holds an image file and no text.

## Root cause (verified in source, origin/main)
- `useClaudeImagePaste.handlePaste` returns `{ handledImages: false }` at once for a provider without image support. The textarea's default paste of an image-only clipboard inserts nothing, and `usePasteToFocus` appends only text. Nothing is said.

## Design (contract)
- In that early return, read `clipboardData` synchronously. If it has an `image/*` ITEM and no `text/plain`, show a toast (through the hook's `showToast`, the pane toast): "<shortLabel> can't take pasted images."
- **Only an image FILE item with no text counts.** Copying from a web page often carries `<img>` in `text/html` alongside text, and that text paste must stay silent. A mixed image+text paste pastes the text as before, with no toast.
- It still returns `handledImages: false`, so the text routing is unchanged.

## Tests
New `useClaudeImagePaste.renderer.test.tsx` renders the real hook, with a real PNG from `testing/fixtures/image-reads` placed in a `DataTransfer`.
- Codex, image only: the toast shows. Red on main.
- Codex, image plus text: no toast (the text pastes).
- Codex, text only: no toast.
- Claude, image only: no such toast (the image is taken).

## Out of scope
- #1250's other rows.
- Image support for other providers.
