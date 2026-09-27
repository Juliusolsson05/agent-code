# Codex: a draft taller than 12 rows is still a draft (#1327)

Size: short plan. The root cause is known from a recording.

## Outcome
A human draft in a Codex 0.157 composer that is taller than 12 rows reads `drafted`, so Agent Code refuses to paste or submit into it: its own Enter/Send path (the existing `composer-occupied` guard) and orchestration delivery both refuse.

## Evidence (verified 2026-09-26, do not re-derive)
- **Recording:** `packages/codex-headless/testing/fixtures/composer-0157/tall-draft-ctrlc.json`. Real codex-cli 0.157.1 at 100×30: idle, then a 20-line draft typed with Ctrl+J newlines, then Ctrl+C twice.
- **Codex does not scroll the marker away.** The composer grows upward: at 20 lines, `›` is on row 7 and the draft fills rows 7–26, above the blank separator and the footer.
- **The `unknown` comes from our classifier.** `classifyCodexComposerState` searches for the marker only `MAX_COMPOSER_ROWS = 12` rows above the separator. Replay: `drafted` through 11 rows, `unknown` from 14 rows, `empty` after Ctrl+C.
- **Why `unknown` is harmful here.** `unknown` publishes `provider-not-ready`, and the pane's Enter guard refuses only `composer-occupied`, so Enter appends to the human's draft (#1327, from the #1319 round-2 review A1).
- **Why a new "unreadable" reason was not chosen** (the issue's first proposal). `unknown` also covers idle, empty composers that cannot be PROVEN empty: a narrow pane drops the `? for shortcuts` hint row. Refusing Enter on those would trap the user's input (class C4).

## Change (codex-headless `fix/composer-tall-draft`, then the pointer here)
The 12-row bound stays for the ordinary search, where blank rows between marker and separator are allowed (a draft can hold blank lines). Past 12 rows the search goes on only through UNBROKEN non-blank rows, up to the top of the viewport. That is how a tall composer looks in the recording, and a transcript `›` above a blank row is never reached. Nothing else in the classifier changes.

## Tests
- **Package, on the recording:** `drafted` at 11, 14 and 20 rows (red on main from 14); `empty` after Ctrl+C; a transcript `›` across a blank row above 12 rows stays `unknown`.
- **App:** replaying the recording through a real `CodexHeadless`: the 20-row draft publishes `composer-occupied`, and delivery is refused with no write. The existing "unclassifiable" tests move to a shape that is still unclassifiable: a blank line inside a draft taller than 12 rows.

## Residual (hence `Refs #1327`, not `Fixes`)
- A draft with a blank line more than 12 rows above the separator is still `unknown`, and so is a draft taller than the viewport, whose marker scrolls off. Both are unrecorded.
- For both, Enter still writes; orchestration delivery refuses them.

## Verification
- Package: suite and `tsc`.
- App: codex suites, keybinds, `npx tsc -b`.
- No app launch. The recording was made with the standalone Codex, not the app.
