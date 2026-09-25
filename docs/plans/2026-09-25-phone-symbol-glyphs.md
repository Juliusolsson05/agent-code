# Phone: stop feed symbols rendering as Apple color emoji (#1194)

Status: implemented on `fix/phone-symbol-glyphs` (PR #1196). The first
approach was rejected in review and reverted; see **Review round**.

## Root cause (verified)

- The phone mounts the desktop's own feed rows (#1186).
- Those rows draw app symbols that carry the Unicode Emoji property
  (Extended_Pictographic). The set, found by walking the phone bundle's import
  graph:
  - `⏺` U+23FA, the Claude tool bullet (29 sites);
  - `⏸`;
  - `☑` (with `☐` as its pair);
  - `🖼`;
  - `↗`;
  - `↩`.
- The app's coding faces lack them; JetBrains Mono lacks `⏺ ⏸ ☑ 🖼` (checked
  against its cmap).
- When no named face has a glyph, the platform's last resort draws it:
  - on macOS it is a monochrome system symbol font, so the desktop looked fine;
  - on iOS Safari it is Apple Color Emoji.
- Earlier fixes (`5ad922cf`) moved the phone's own chrome to SVG icons but
  never reached the shared rows, which is why the emoji kept coming back.

## Fix (phone only)

- **A self-hosted symbol face, `'Agent Code Symbols'`**, declared in
  `src/remote-client/src/styles.css`, with two WOFF2 files:
  - `agent-code-symbols-a.woff2` is a 5-glyph subset of Noto Sans Symbols 2
    (`⏸ ⏺ ☐ ☑ 🖼`), 1.2 KB;
  - `agent-code-symbols-b.woff2` is a 2-glyph subset of Noto Sans Math
    (`↗ ↩`), 0.8 KB.
  - Both are OFL; `assets/fonts/OFL.txt` carries both copyright lines.
  - The pyftsubset commands sit in the CSS comment.
  - Each subset's cmap was verified to map exactly its glyphs.
- **Scoped by `unicode-range`** to exactly those code points. Every other
  character, including emoji an agent writes (⭐ 👍 ⏳ 🟢), never matches the
  face and renders as it always did.
- **Placed first** in the phone's font stack (`phoneSymbolFont.ts`, applied
  once at phone boot by rewriting the inline `--theme-app-font` that
  `applyTheme` set). It has to be first because WebKit expands `ui-monospace`
  into a system cascade that reaches Apple Color Emoji before any face listed
  after it. The `unicode-range` is what makes "first" safe.
- **Bundled.** Vite inlines both files into the phone CSS as data URIs (they
  are under its 4 KB inline limit), so there are no requests and no CDN
  dependency. The `unicode-range` survives minification (checked in
  `out/remote-client`).
- **The desktop is unchanged.** It never had the bug, and its glyphs, its
  terminal and its editor keep their fonts.

## Verification

`src/remote-client/src/phoneSymbolFont.test.ts` has three checks:

- **Coverage.** It walks the phone bundle's import graph from
  `remote-client/src/main.tsx`, resolving aliases, relative paths and index
  files the way the bundler does. It collects every Extended_Pictographic
  character in code (comments stripped) and fails if any falls outside the
  face's `unicode-range`. So a new emoji-property symbol in a phone-rendered
  row cannot silently bring the emoji back.
- **Self-hosting.** Every face `src` must be a local file that exists.
- **Order and wiring.** The helper must put the face first, and the phone boot
  must apply it.

Mutations checked (each goes red): dropping `⏺` from the range, pointing a face
at a CDN, and removing the boot wiring.

Also verified: `npx tsc -b`, `npm run client:build`, and the inlined faces and
ranges in the built CSS.

Not verified on a device: per standing instruction the app is not launched.
The evidence is the glyph coverage, the unicode-range scoping and the ordering
above.

## Review round

Reviewers: one Codex (glyph coverage and fallback semantics) and one Claude
(consumers, tests and integration).

| Finding | Verdict | Disposition |
|---|---|---|
| An app-wide Noto stack also turned agent-written emoji (⭐ 👍 ⏳ 🟢) monochrome, on desktop and phone; reproduced in headless Chrome | valid | Approach reverted; the phone-only face is `unicode-range`-scoped to the app's own symbols |
| iOS WebKit expands `ui-monospace` and can reach Apple Color Emoji before a later face | valid | The phone face goes first in the stack |
| The fix vanished whenever Google Fonts was unreachable | valid | Self-hosted and inlined into the phone CSS |
| The desktop `⏺` glyph changed (a wider Noto glyph) although the desktop had no bug | valid | The desktop is untouched |
| The test survived removing either face from the constant, and the `&` check broke on a harmless reorder | valid | The test was rewritten against coverage, local source and wiring, and mutation-checked |
| `↩` was uncovered by both Noto faces | valid | Added to subset b (Noto Sans Math) |
| xterm glyph-cache and line-height suspicions | moot | The desktop and its terminal no longer change |
