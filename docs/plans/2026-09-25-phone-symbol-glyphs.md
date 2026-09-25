# Phone: stop feed symbols rendering as Apple color emoji (#1194)

## Root cause (verified)

- The phone mounts the desktop's own feed rows (#1186). Those rows draw
  symbol characters that carry the Unicode Emoji property:
  - `⏺` U+23FA, the Claude tool bullet, used 29 times;
  - `⏸`;
  - `☑` and `☐`;
  - `🖼`;
  - `↗`.
- The app font stack is `'<face>', ui-monospace, Menlo, Monaco, monospace`.
  The default face, JetBrains Mono, has no glyph for `⏺ ⏸ ☑ 🖼`; I checked
  its cmap with fontTools.
- On macOS, Chromium falls back to a monochrome system symbol font. iOS
  Safari has none, so it falls back to Apple Color Emoji.
- Earlier fixes (`5ad922cf`) replaced emoji in the phone's own chrome with
  bundled SVG icons, but never the shared rows, which is why the emoji kept
  coming back.

## Fix

- Every font option's stack gains two monochrome symbol faces,
  **'Noto Sans Symbols 2'** and **'Noto Sans Symbols'**, placed after the
  system monospace faces and before the generic `monospace`.
- Glyph coverage, verified against the fonts' cmaps:
  - Noto Sans Symbols 2 covers `⏺ ⏸ ☑ ☐ 🖼 ✓ ✗ ◐ ◌ ▸ ▾ ▴ ❯ ● ✕ ⌘ ◷ ◍`.
  - Noto Sans Symbols covers `↗`.
- Why after the system monospace faces: xterm.js renders the desktop
  terminal with this same string, and the desktop must not change the glyph
  source for anything Menlo or Monaco already draws. The Noto faces only
  catch characters that would otherwise fall through to the platform's last
  resort, which on iOS is the emoji font.
- The stack is built by one helper, so the five options cannot drift.
- Both families are added to the existing Google Fonts `@import` in
  `styles.css`. Google Fonts serves unicode-range subsets, so a client only
  downloads a subset when it actually draws one of those characters.

## Not changed

Emoji that agents write in their own text (for example ✅) are content. They
still render as emoji on both clients, which matches the desktop.

## Verification

- A test pins that every font option's stack names both symbol faces before
  the generic family, and that `styles.css` imports both. Without the import,
  a font named in the stack silently falls back to Apple Color Emoji.
- `npx tsc -b` and the settings and theme suites.
- No device check: per standing instruction the app is not launched. The
  glyph coverage above is the evidence.
