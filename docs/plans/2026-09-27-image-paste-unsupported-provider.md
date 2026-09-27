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
- Claude, image only: no such toast, and the image is taken (`handledImages: true`, draft images set).

## Out of scope
- #1250's other rows.
- Image support for other providers.

## Review round 1 (a, b: FIX-BEFORE-MERGE)
- **b1: an image FILE plus text dropped the image silently** ("see attached" with no attachment). The text still pastes, and the toast says "…only the text was pasted." A file item is strong evidence; only an HTML `<img>` beside text (a web-page copy) stays silent.
- **a2 / b2: an image arriving only as a data-URL `<img>` in text/html, with no text, was silent.** It now counts.
- **a3: an image only the async clipboard API shows was silent.** With nothing else in the event (no text, no HTML, no items), `readImagesFromClipboard` is probed. Paste-to-focus's documented miss of this shape is unchanged (it never calls the hook for it).
- **b3: the wording blamed the provider.** Grok's own TUI attaches clipboard images. The sentence is now about this composer: "Pasted images can't be sent to <Provider> from this composer."
- **a1 (terminal view): declined.** There the paste goes to the provider's own TUI, which owns image handling (Grok's attaches images); the app's capability flag is about its composer.
- **a4: every provider's wording is tested** (Codex, OpenCode, Grok, Pi).
- `parseImagesFromHtml` uses `querySelectorAll('img')` instead of `doc.images`. It is identical in a browser, and the happy-dom test DOM lacks `images` on a parsed document.
- **c (MERGE-READY, reviewing the round-0 head; test gaps pinned):** a non-image file, a type-less file, a string item typed `image/*`, and a null `clipboardData` stay silent. The Claude case asserts the image is taken. The provider label is covered by the per-provider cases.
