// Codex TUI chrome stripper — counterpart to
// src/core/parsers/claude/streamingScreen.ts.
//
// Codex's TUI markers (confirmed from testbench recordings):
//   › (U+203A) — user prompt prefix
//   • (U+2022) — assistant text + tool call prefix
//   │ └        — tool output sub-items (box drawing)
//   ──────     — horizontal divider (same as Claude)
//   gpt-X.Y … — status line (model + cwd, no ⏵⏵ prefix)
//   ╭╮╰╯│     — banner box around "OpenAI Codex (vX.Y.Z)"
//
// The structure mirrors Claude's parser: strip the bottom chrome
// (status row, dividers, empty prompt), then walk backward for the
// last assistant marker to extract the in-progress response.
//
// Pure: no Node, no DOM, no IO. Importable from main, renderer, testbench.

const BOX_CHARS_RE = /[╭╮╰╯─│┌┐└┘├┤┬┴┼━┃═║]/g

// Codex status line markers. Unlike Claude's "⏵⏵ bypass permissions on",
// codex shows "gpt-X.Y model · ~/path" or just the model name.
const CODEX_STATUS_MARKERS = [
  'gpt-',        // model prefix in status
  '/model',      // hint to change model
  '/fast',       // fast mode hint
]

/** Horizontal-rule line: at least 10 ─/━/═ chars and almost nothing else. */
export function isCodexDividerLine(line: string): boolean {
  const dividerChars = (line.match(/[─━═▔]/g) ?? []).length
  if (dividerChars < 10) return false
  const nonSpace = line.replace(/\s/g, '').length
  return dividerChars >= nonSpace * 0.8
}

/** Codex's prompt-indicator row: `›` followed by whitespace only (empty composer). */
export function isCodexPromptLine(line: string): boolean {
  return /^\s*›\s*$/.test(line)
}

/**
 * A line that starts with `›` followed by text content — a user
 * prompt echo or the composer with placeholder text. Used as a
 * stop-terminator when extracting the assistant block (same role
 * as Claude's isUserPromptLine).
 */
export function isCodexUserPromptLine(line: string): boolean {
  return /^\s*›\s+\S/.test(line)
}

/** Codex's persistent status row — model + cwd. */
export function isCodexStatusLine(line: string): boolean {
  return CODEX_STATUS_MARKERS.some(m => line.includes(m))
}

/**
 * A line is "chrome" if it's part of codex's persistent UI furniture
 * rather than scrollable content.
 */
export function isCodexChromeLine(line: string): boolean {
  if (line.trim() === '') return true
  if (isCodexDividerLine(line)) return true
  if (isCodexPromptLine(line)) return true
  if (isCodexStatusLine(line)) return true
  // Stripped of box-drawing chars there's nothing left — it's a
  // banner border or decorative line.
  const stripped = line.replace(BOX_CHARS_RE, '').trim()
  if (stripped.length === 0) return true
  return false
}

// The assistant marker codex uses — • (U+2022, bullet).
const CODEX_ASSISTANT_MARKER = '•'
const CODEX_ASSISTANT_MARKER_RE = /^\s*•\s?/

// Codex tool-output sub-items use box-drawing: │ and └
const CODEX_TREE_MARKER_RE = /^\s*[│└]/

// Codex spinner — uses braille spinner chars (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏)
// followed by a word, similar to Claude's ✻ spinners.
const CODEX_SPINNER_RE = /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s/

/**
 * Returns true if a line is codex's mid-turn tool/thinking UI chrome.
 */
export function isCodexIntermediateChromeLine(line: string): boolean {
  if (CODEX_TREE_MARKER_RE.test(line)) return true
  if (CODEX_SPINNER_RE.test(line)) return true
  return false
}

/**
 * Strip the bottom chrome from a codex screen snapshot.
 * Returns everything above the persistent input box + status row.
 */
export function extractCodexStreamingText(screen: string): string {
  if (!screen) return ''
  const lines = screen.split('\n')

  // Walk from bottom up, stripping contiguous chrome.
  let cutFrom = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isCodexChromeLine(lines[i] ?? '')) {
      cutFrom = i
    } else {
      break
    }
  }

  const head = lines.slice(0, cutFrom)

  // Trim trailing blank/chrome lines from what remains.
  while (head.length > 0 && isCodexChromeLine(head[head.length - 1] ?? '')) {
    head.pop()
  }
  // Trim leading blanks.
  let start = 0
  while (start < head.length && (head[start] ?? '').trim() === '') start++

  return head.slice(start).join('\n')
}

/**
 * Extract just the most-recent assistant text block from a codex
 * screen snapshot.
 *
 * Same algorithm as Claude's extractAssistantInProgress:
 *   1. Strip bottom chrome via extractCodexStreamingText.
 *   2. Filter intermediate chrome (tool sub-items, spinners).
 *   3. Walk backward for the last `•` marker.
 *   4. Slice from that marker to the first `›` user-prompt line
 *      (stop-terminator for queued messages).
 *   5. Strip the marker off the head line.
 *   6. Trim trailing blanks + dividers.
 */
export function extractCodexAssistantInProgress(screen: string): string {
  const stripped = extractCodexStreamingText(screen)
  if (!stripped) return ''

  // Filter intermediate chrome before walking for the marker.
  const lines = stripped
    .split('\n')
    .filter(l => !isCodexIntermediateChromeLine(l))

  // Find the last assistant marker.
  let lastMarkerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CODEX_ASSISTANT_MARKER_RE.test(lines[i] ?? '')) {
      lastMarkerIdx = i
      break
    }
  }
  if (lastMarkerIdx === -1) return ''

  // Find where the assistant block ends — stop at user prompt lines.
  let endIdx = lines.length
  for (let i = lastMarkerIdx + 1; i < lines.length; i++) {
    if (isCodexUserPromptLine(lines[i] ?? '')) {
      endIdx = i
      break
    }
  }

  const block = lines.slice(lastMarkerIdx, endIdx)
  // Strip the marker off the first line.
  block[0] = (block[0] ?? '').replace(CODEX_ASSISTANT_MARKER_RE, '')

  // Trim trailing blank lines + dividers.
  while (
    block.length > 0 &&
    ((block[block.length - 1] ?? '').trim() === '' ||
      isCodexDividerLine(block[block.length - 1] ?? ''))
  ) {
    block.pop()
  }

  // Normalize trailing whitespace per line.
  return block.map(l => l.replace(/[ \t]+$/, '')).join('\n')
}
