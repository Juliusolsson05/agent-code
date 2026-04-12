// Codex TUI chrome stripper — counterpart to
// src/core/parsers/claude/streamingScreen.ts.
//
// Codex's TUI uses different markers than Claude:
//   - Input gutter: "▌ " (U+258C left half block + space, 2 cols)
//   - Assistant content: rendered inline (exact prefix TBD — will
//     be refined after the first live recording via
//     `npm run record:codex`)
//   - Status / footer: exact content TBD
//
// This is a STUB implementation that does minimal chrome stripping:
// strip trailing blanks, strip the gutter prefix where present. It's
// enough to get a basic streaming card showing content; the exact
// chrome patterns will be refined iteratively against real recordings,
// the same way Claude's parser was iterated against testbench fixtures.
//
// Pure: no Node, no DOM, no IO. Importable from main, renderer, testbench.

/**
 * Strip obvious chrome from a codex screen snapshot.
 *
 * Currently: trims trailing blank lines and strips the `▌ ` gutter
 * prefix from lines that have it. Will grow more rules as we
 * discover codex's chrome patterns from real recordings.
 */
export function extractCodexStreamingText(screen: string): string {
  if (!screen) return ''
  const lines = screen.split('\n')

  // Strip trailing empty lines (visual padding from the TUI layout).
  while (lines.length > 0 && (lines[lines.length - 1] ?? '').trim() === '') {
    lines.pop()
  }

  // Strip leading empty lines too.
  let start = 0
  while (start < lines.length && (lines[start] ?? '').trim() === '') start++

  return lines
    .slice(start)
    .map(l => l.replace(/^▌ /, ''))
    .join('\n')
}

/**
 * Extract just the most-recent assistant text block from a codex
 * screen snapshot.
 *
 * Placeholder implementation: returns the full chrome-stripped text.
 * Once we have real recordings and know how codex visually separates
 * user turns from assistant turns in the terminal buffer, this will
 * be refined to walk backward from the bottom and find the last
 * assistant block (same approach as Claude's extractAssistantInProgress
 * which walks backward looking for the `⏺` marker).
 */
export function extractCodexAssistantInProgress(screen: string): string {
  return extractCodexStreamingText(screen)
}
