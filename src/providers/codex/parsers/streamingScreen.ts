// Codex TUI chrome stripper + assistant extractor.
//
// Codex's TUI markers (confirmed from recording 2026-04-12T13-36-22):
//
//   › (U+203A)  — user prompt prefix (empty composer or submitted prompt)
//   • (U+2022)  — assistant text, tool calls, and working indicator
//   ◦ (U+25E6)  — alternate assistant marker (older versions)
//   └           — tool output sub-item prefix
//   │           — tool output continuation
//   ──────      — horizontal divider
//   ╭╮╰╯│      — welcome banner box-drawing
//
// Status line patterns (bottom of screen):
//   "gpt-5.4 medium fast · ~/path"
//   "gpt-5.4 medium fast · ~/path · Main [default]"
//   "tab to queue message ... N% context left"
//
// Working indicators (all prefixed with •):
//   "• Working (Ns • esc to interrupt)"
//   "• Working (Ns • esc to interrupt) · 1 background terminal running"
//   "• Booting MCP server: name (Ns • esc to interrupt)"
//
// Tool-call chrome (prefixed with • but NOT assistant content):
//   "• Ran git status --short"
//   "• Explored"
//   "• Edited 4 files (+18 -2)"
//   "• Called codex.list_mcp_resources({})"
//   "• Calling codex.list_mcp_resources({})"
//   "• Spawned Name [role] (model)"
//   "• Closed Name [role]"
//   "• Updated Plan"
//   "• Finished waiting"
//
// Pure: no Node, no DOM, no IO.

const BOX_CHARS_RE = /[╭╮╰╯─│┌┐└┘├┤┬┴┼━┃═║]/g

// --- Status line detection ---
//
// Codex's persistent status row at the bottom. Multiple variants
// observed in recordings. We match substrings, not full lines.
const CODEX_STATUS_MARKERS = [
  'gpt-',                // model name prefix
  'context left',        // "82% context left" on the queue hint line
  'tab to queue',        // queue hint
  '/model to change',    // hint inside the welcome banner
]

/** Horizontal-rule line: at least 10 ─/━/═ chars and almost nothing else. */
export function isCodexDividerLine(line: string): boolean {
  const dividerChars = (line.match(/[─━═▔]/g) ?? []).length
  if (dividerChars < 10) return false
  const nonSpace = line.replace(/\s/g, '').length
  return dividerChars >= nonSpace * 0.8
}

/**
 * Codex's prompt-indicator row: `›` followed by whitespace only (empty
 * composer) or placeholder text like "Improve documentation in @filename".
 * Accept optional markdown emphasis wrappers because terminalToMarkdown
 * may bold the prompt glyph.
 */
export function isCodexPromptLine(line: string): boolean {
  return /^\s*(?:\*{1,3})?›(?:\*{1,3})?\s*$/.test(line)
}

/**
 * A line that starts with `›` followed by text content — a user
 * prompt echo or the composer with active input/placeholder text.
 * Used as a stop-terminator when extracting the assistant block.
 */
export function isCodexUserPromptLine(line: string): boolean {
  return /^\s*(?:\*{1,3})?›(?:\*{1,3})?\s+\S/.test(line)
}

/** Codex's persistent status row — model + cwd + hints. */
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

// --- Assistant marker ---

const CODEX_ASSISTANT_MARKER_RE = /^\s*(?:\*{1,3})?[•◦](?:\*{1,3})?\s?/

// --- Intermediate chrome: tool calls, spinners, working status ---
//
// These lines are prefixed with • (same as assistant text) but are
// NOT real assistant content. They must be filtered BEFORE we walk
// backward looking for the last • marker, otherwise we'd land on
// "• Ran git status" or "• Working (3s...)" instead of the real
// response text.

// Tool-output sub-items: │ and └ prefixes.
const CODEX_TREE_MARKER_RE = /^\s*[│└]/

// Braille spinner characters (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏).
const CODEX_SPINNER_RE = /^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s/

// "• Working (Ns • esc to interrupt)" — the primary activity indicator.
// Also matches "• Booting MCP server: name (Ns • esc to interrupt)".
const CODEX_ESC_HINT_RE = /esc to interrupt/

// Tool-call labels: "• Ran ...", "• Explored", "• Edited ...", etc.
// These are one-line summaries of tool executions. They always start
// with • followed by a past-tense or gerund verb. We identify them
// by the verb patterns observed in recordings.
//
// Why not just check for "esc to interrupt"? Because tool-call labels
// like "• Ran git status" do NOT have the esc hint — only the Working
// spinner does. But they ARE chrome that should be filtered from the
// assistant text extraction.
const CODEX_TOOL_CALL_VERBS = [
  'Ran ',
  'Explored',
  'Edited ',
  'Called ',
  'Calling ',
  'Spawned ',
  'Closed ',
  'Updated Plan',
  'Finished waiting',
  'Booting MCP',
  'Created ',
  'Deleted ',
  'Wrote ',
  'Read ',
  'Listed ',
  'Searched ',
]

// Build a regex that matches "• <verb>" for any of the known verbs.
const CODEX_TOOL_CALL_RE = new RegExp(
  String.raw`^\s*(?:\*{1,3})?[•◦](?:\*{1,3})?\s+(?:${CODEX_TOOL_CALL_VERBS.map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`,
)

/**
 * Returns true if a line is codex's mid-turn tool/thinking UI chrome.
 * Must be called on individual lines, not the full screen text.
 */
export function isCodexIntermediateChromeLine(line: string): boolean {
  if (CODEX_TREE_MARKER_RE.test(line)) return true
  if (CODEX_SPINNER_RE.test(line)) return true
  if (CODEX_ESC_HINT_RE.test(line)) return true
  if (CODEX_TOOL_CALL_RE.test(line)) return true
  return false
}

// --- Trust dialog detection (inlined) ---

const TRUST_DIALOG_MARKERS = [
  'Do you trust the contents of this directory',
  'Yes, continue',
  'No, quit',
]

function isTrustDialogVisible(screen: string): boolean {
  return TRUST_DIALOG_MARKERS.every(m => screen.includes(m))
}

// --- Resume picker detection ---

const RESUME_PICKER_MARKERS = [
  'Resume a previous session',
  'enter to resume',
  'esc to start new',
]

function isResumePicker(screen: string): boolean {
  return RESUME_PICKER_MARKERS.every(m => screen.includes(m))
}

// --- Activity detection ---
//
// Detect whether Codex is actively working from the screen buffer.
// Returns a status string when working, null when idle.

/** Working line regex — extracts timing. */
const CODEX_WORKING_RE = /[•◦]\s+Working\s*\((\d+(?:m\s+\d+)?)s/

/** Booting MCP regex. */
const CODEX_BOOTING_RE = /[•◦]\s+Booting\s+MCP\s+server:\s+(\S+)/

/**
 * Detect Codex's activity state from the plain-text screen buffer.
 * Scans the last ~15 lines (where the working indicator sits).
 *
 * Returns a short status string when working, or null when idle.
 */
export function detectCodexActivity(screen: string): string | null {
  if (!screen) return null
  const lines = screen.split('\n')

  const start = Math.max(0, lines.length - 15)
  for (let i = lines.length - 1; i >= start; i--) {
    const line = lines[i] ?? ''

    // Primary: "• Working (Ns • esc to interrupt)"
    const workMatch = CODEX_WORKING_RE.exec(line)
    if (workMatch) {
      return `working… ${workMatch[1]}s`
    }

    // Secondary: "• Booting MCP server: name (...)"
    const bootMatch = CODEX_BOOTING_RE.exec(line)
    if (bootMatch) {
      return `booting ${bootMatch[1]}…`
    }

    // Braille spinner (rare — usually accompanied by Working)
    if (CODEX_SPINNER_RE.test(line)) {
      return 'working…'
    }
  }

  return null
}

// --- Streaming text extraction ---

/**
 * Strip the bottom chrome from a codex screen snapshot.
 * Returns everything above the persistent input box + status row.
 * Returns '' when the trust dialog or resume picker is on screen.
 */
export function extractCodexStreamingText(screen: string): string {
  if (!screen) return ''
  if (isTrustDialogVisible(screen)) return ''
  if (isResumePicker(screen)) return ''

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

// --- Assistant text extraction ---

/**
 * Extract just the most-recent assistant text block from a codex
 * screen snapshot.
 *
 * Algorithm:
 *   1. Strip bottom chrome via extractCodexStreamingText.
 *   2. Filter intermediate chrome (tool calls, spinners, sub-items).
 *   3. Walk backward for the last `•` marker that ISN'T chrome.
 *   4. Slice from that marker to the first `›` user-prompt line
 *      (stop-terminator for queued messages).
 *   5. Strip the marker off the head line.
 *   6. Trim trailing blanks + dividers.
 *
 * Returns '' when no assistant text is on screen — the consumer
 * should show a "thinking…" or activity placeholder in that case.
 */
export function extractCodexAssistantInProgress(screen: string): string {
  const stripped = extractCodexStreamingText(screen)
  if (!stripped) return ''

  const allLines = stripped.split('\n')

  // Filter intermediate chrome before walking for the marker.
  // This removes tool-call labels, tree sub-items, spinners, and
  // working indicators — all of which use the same `•` prefix as
  // real assistant text.
  const lines = allLines.filter(l => !isCodexIntermediateChromeLine(l))

  // Find the last assistant marker.
  let lastMarkerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (CODEX_ASSISTANT_MARKER_RE.test(lines[i] ?? '')) {
      lastMarkerIdx = i
      break
    }
  }

  // Fallback: if filtering removed ALL `•` lines, check if there's
  // a Working indicator in the unfiltered text and return a clean
  // activity status so the consumer shows progress instead of
  // "thinking…" forever.
  if (lastMarkerIdx === -1) {
    const activity = detectCodexActivity(stripped)
    if (activity) return activity
    return ''
  }

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
