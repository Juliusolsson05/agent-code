// The screen buffer we receive from the headless terminal contains CC's
// full Ink UI: the previous user message, the assistant's in-progress
// response, and a bordered input box at the bottom. For the streaming
// card we want only the middle (the in-progress response), so we strip
// the obvious chrome.
//
// This is a heuristic — CC's TUI layout can change between releases and
// any chrome we don't recognize will leak through. The fix isn't to make
// this regex bulletproof; it's to keep this function pure and exercise
// it from `testbench/replay.ts` against real recorded sessions, then
// iterate the rules until they hold for every fixture.
//
// Pure: no Node, no DOM, no IO. Importable from main, renderer, testbench.

const BOX_CHARS_RE = /[╭╮╰╯─│┌┐└┘├┤┬┴┼━┃═║]/g

/**
 * Markers that appear ONLY in CC's persistent bottom status row.
 * Validated against testbench/scripts/startup-trusted.json fixture
 * (recordings/2026-04-10T15-02-12-788Z). Add new markers when we discover
 * them by replaying fresh fixtures — keep this list specific so we don't
 * false-positive on real assistant content.
 */
const STATUS_LINE_MARKERS = [
  '⏵⏵',
  'bypass permissions on',
  'shift+tab to cycle',
  '/effort',
  'plan mode',
  'auto-accept edits',
]

/** A horizontal-rule line: at least 10 ─/━/═ chars and almost nothing else. */
export function isDividerLine(line: string): boolean {
  const dividerChars = (line.match(/[─━═▔]/g) ?? []).length
  if (dividerChars < 10) return false
  const nonSpace = line.replace(/\s/g, '').length
  return dividerChars >= nonSpace * 0.8
}

/** CC's prompt-indicator row: `❯` (or `>`) followed by whitespace only. */
export function isPromptLine(line: string): boolean {
  return /^\s*[❯>]\s*$/.test(line)
}

/**
 * A line that starts with `❯` followed by text content. CC uses this
 * shape for queued user messages (and for the "your submitted prompt"
 * echo at the top of a turn). Distinct from `isPromptLine` above which
 * matches the empty composer indicator only.
 *
 * We need this as its own predicate because queued messages visually
 * appear BELOW the assistant's in-progress response in CC's layout —
 * i.e. between the last `⏺` marker and the bottom chrome. The
 * assistant extraction walk would otherwise slurp them up as if they
 * were part of the assistant block, so extractAssistantInProgress
 * uses it as a stop-terminator. See the comment on that function for
 * the bleed-through reproduction.
 *
 * Leading whitespace is allowed because CC indents queued messages
 * two cells — `  ❯ now name three colors`.
 */
export function isUserPromptLine(line: string): boolean {
  return /^\s*❯\s+\S/.test(line)
}

/** The persistent bottom status row that shows mode + effort + hints. */
export function isStatusLine(line: string): boolean {
  return STATUS_LINE_MARKERS.some(m => line.includes(m))
}

/**
 * A line is "chrome" if it's part of CC's persistent UI furniture (input
 * box, dividers, status row) rather than scrollable content. This is a
 * heuristic — exercised against fixtures in `recordings/`. Update when a
 * new fixture exposes a chrome pattern we don't yet recognize.
 */
export function isChromeLine(line: string): boolean {
  if (line.trim() === '') return true
  if (isDividerLine(line)) return true
  if (isPromptLine(line)) return true
  if (isStatusLine(line)) return true
  // Original heuristic: stripped of box-drawing chars there's nothing left.
  const stripped = line.replace(BOX_CHARS_RE, '').trim()
  if (stripped.length === 0) return true
  return false
}

/**
 * The glyph CC's Ink uses at the start of an assistant message line.
 * Looks like a filled circle (U+23FA "BLACK CIRCLE FOR RECORD"). Distinct
 * from `❯` which CC uses for the user's typed prompt indicator.
 *
 * If CC ever changes this glyph, only this constant + the regex below
 * need updating — the rest of `extractAssistantInProgress` is structural
 * (find-the-last-line-starting-with-marker).
 */
export const ASSISTANT_LINE_MARKER = '⏺'

const ASSISTANT_MARKER_RE = /^\s*⏺\s?/

// -----------------------------------------------------------------------------
// Intermediate chrome: CC's tool-call + thinking UI decorations.
//
// These lines appear in the middle of a turn (not at the bottom) while CC is
// running a tool or thinking. They look superficially like content because
// they show up between the user's message and the assistant's final text,
// but they're actually UI furniture:
//
//   ⏺ Listing 1 directory… (ctrl+o to expand)     ← tool call label
//     ⎿  $ ls -1 /private/tmp | wc -l && …        ← tool command echo
//     ⎿  (result line 1)                          ← tool result sub-item
//     ⎿  Tip: Run /install-github-app to tag…     ← rotating tip
//   ✻ Newspapering… (thinking)                    ← rotating spinner
//
// Critically, tool-call labels are prefixed with the SAME `⏺` marker CC uses
// for assistant text. So "find the last `⏺`" would (and did) land on a tool
// call label and return "Listing 1 directory…" as if it were assistant text.
// The filter below has to run BEFORE the last-marker scan, not after.
// -----------------------------------------------------------------------------

// Tree marker (U+23BF, "curly bracket section"). CC uses this for every
// indented sub-item under a tool call — commands, result lines, tips. A line
// that starts with it (after optional whitespace) is always chrome.
const TREE_MARKER_RE = /^\s*⎿/

// Tool call labels end with a keybinding hint CC injects: "(ctrl+o to
// expand)", "(ctrl+r to retry)", etc. Assistant-authored text essentially
// never contains this shape, so it's a strong-positive marker. The `\w+`
// matches "ctrl", "cmd" etc.
const TOOL_LABEL_HINT_RE = /\(ctrl\+\w+\s+to\s+[^)]+\)/

// Spinner + progress lines: a leading non-word, non-whitespace glyph (CC
// rotates through ✢ ✶ · ✻ ✽ ✺ etc.) followed by a word ending in `…`, often
// with a parenthetical qualifier like "(thinking)". The regex explicitly
// excludes `⏺` so real assistant text ending with `…` isn't misfired.
const SPINNER_LINE_RE = /^\s*[^\w\s⏺]\s+\S+…/

/**
 * Returns true if a line is CC's mid-turn tool/thinking UI chrome, not
 * assistant content. Exported separately so parsers / tests can reason
 * about each rule.
 */
export function isIntermediateChromeLine(line: string): boolean {
  if (TREE_MARKER_RE.test(line)) return true
  if (SPINNER_LINE_RE.test(line)) return true
  if (TOOL_LABEL_HINT_RE.test(line)) return true
  return false
}

// ---------------------------------------------------------------------------
// Activity detection: is CC actively working right now?
//
// CC renders a spinner line while it's busy — one of the rotating glyphs
// (✢ ✶ · ✻ ✽ ✺) followed by a verb ending in "…", e.g. "✻ Cogitating…".
// This is the single most reliable screen-level signal: it's present IFF
// CC is processing (API call in flight, tool executing, thinking). When CC
// is idle (waiting for user input), the spinner line is absent and the
// screen shows only the prompt indicator (❯).
//
// We also detect tool-call labels ("⏺ Reading file… (ctrl+o to expand)")
// as a secondary signal — these persist while a tool is running even
// between spinner frame updates.
//
// The detector returns either null (idle) or a status string extracted
// from the spinner verb, so the UI can show "Working…" / "Thinking…" etc.
// ---------------------------------------------------------------------------

/**
 * Regex to extract the verb from a spinner line. Captures the word
 * before the "…" — e.g. from "✻ Cogitating… (thinking)" we get
 * "Cogitating". The parenthetical qualifier is optional.
 */
const SPINNER_VERB_RE = /^\s*[^\w\s⏺]\s+(\S+)…/

/**
 * Detect CC's activity state from the plain-text screen buffer.
 *
 * Returns a short status string when CC is working (e.g. "Cogitating…",
 * "Reading file…"), or null when idle. Scans the screen bottom-up
 * because the spinner sits near the bottom of the content area, just
 * above the input chrome.
 */
export function detectActivity(screen: string): string | null {
  if (!screen) return null
  const lines = screen.split('\n')

  // Walk bottom-up: the spinner line sits between the content and
  // the input chrome. We scan the last ~15 lines which is more than
  // enough to cover the chrome + spinner region.
  const start = Math.max(0, lines.length - 15)
  for (let i = lines.length - 1; i >= start; i--) {
    const line = lines[i] ?? ''

    // Primary signal: the rotating-glyph spinner line.
    const verbMatch = SPINNER_VERB_RE.exec(line)
    if (verbMatch) {
      return `${verbMatch[1]}…`
    }

    // Secondary signal: a tool-call label with a keybinding hint.
    // These show "⏺ Editing src/foo.ts… (ctrl+o to expand)". We
    // extract the text between ⏺ and the hint as the status.
    if (TOOL_LABEL_HINT_RE.test(line) && ASSISTANT_MARKER_RE.test(line)) {
      const cleaned = line
        .replace(ASSISTANT_MARKER_RE, '')
        .replace(TOOL_LABEL_HINT_RE, '')
        .trim()
      if (cleaned) return cleaned
    }
  }

  return null
}

/**
 * Strip the trailing input-box block from the bottom of the screen.
 * The input box is a contiguous run of chrome lines at the bottom — once
 * we hit non-chrome content scanning upward, we stop and keep everything
 * above that.
 *
 * This is a low-level primitive: it gives you everything CC was rendering
 * EXCEPT the persistent bottom UI furniture. It's still useful on its own
 * for debugging / fixture inspection / parsers that don't care about
 * assistant boundaries. For the streaming card you almost always want
 * `extractAssistantInProgress` instead, which composes on top of this.
 */
export function extractStreamingText(screen: string): string {
  if (!screen) return ''
  const lines = screen.split('\n')

  // Walk from the bottom up, finding the highest position where the
  // chrome block starts. Anything below that is the input box and gets cut.
  let cutFrom = lines.length
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isChromeLine(lines[i] ?? '')) {
      cutFrom = i
    } else {
      break
    }
  }

  const head = lines.slice(0, cutFrom)

  // Trim trailing blank/chrome lines from the top of what remains too —
  // CC sometimes leaves a few blank rows above the input box.
  while (head.length > 0 && isChromeLine(head[head.length - 1] ?? '')) {
    head.pop()
  }
  // And trim a leading run of blanks at the very top.
  let start = 0
  while (start < head.length && (head[start] ?? '').trim() === '') start++

  return head.slice(start).join('\n')
}

/**
 * Extract just the most-recent assistant text block from the screen.
 *
 * Pipeline:
 *   1. Strip the bottom chrome with `extractStreamingText` — that gives us
 *      everything ABOVE the input box (welcome banner, conversation
 *      history, in-progress assistant text).
 *   2. Walk lines from the bottom up until we find the last line that
 *      starts with the `⏺` assistant marker. Everything from that line
 *      forward is the most recent assistant block.
 *   3. Strip the marker from the head line so the rendered output reads
 *      as plain text.
 *
 * Why "last" `⏺` rather than "first":
 *   A turn can have multiple assistant blocks (text → tool_use → text).
 *   The user wants to see what's CURRENTLY being typed — that's the
 *   most recent block. Earlier blocks land in the JSONL feed and the
 *   structured renderer takes care of them — we don't double-render
 *   them in the streaming card.
 *
 * Why this exists separately from extractStreamingText:
 *   `extractStreamingText` is the chrome-stripper primitive — useful on
 *   its own for fixture inspection and other parsers. This function
 *   composes on top of it to give the streaming card exactly what it
 *   wants: just the current assistant text. Two functions means each
 *   has one job and each is independently testable from `replay.ts`.
 *
 * Why we return the first matching line and forward, not just the line:
 *   Multi-line assistant responses wrap with continuation lines that
 *   DON'T have the `⏺` marker — they're indented continuation. So once
 *   we find the marker, we keep everything from there to the end of the
 *   stripped content (not just that one line).
 *
 * Returns '' when no assistant marker is on screen yet — the streaming
 * card should fall back to a "thinking…" placeholder in that case.
 */
export function extractAssistantInProgress(screen: string): string {
  const stripped = extractStreamingText(screen)
  if (!stripped) return ''

  // CRITICAL ordering: strip intermediate chrome BEFORE walking for the
  // last `⏺` marker. Tool call labels are prefixed with `⏺` too, so if
  // we walked first we'd land on a label like:
  //   `⏺ Listing 1 directory… (ctrl+o to expand)`
  // and return "Listing 1 directory…" as if it were assistant text.
  // Filtering first means any remaining `⏺` is guaranteed to prefix real
  // assistant text (or there's no `⏺` at all and we return '' → thinking).
  const lines = stripped
    .split('\n')
    .filter(l => !isIntermediateChromeLine(l))

  let lastMarkerIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (ASSISTANT_MARKER_RE.test(lines[i] ?? '')) {
      lastMarkerIdx = i
      break
    }
  }
  if (lastMarkerIdx === -1) return ''

  // Find where the assistant block ENDS. Without this, the walk below
  // would grab every line from the marker to the bottom of the stripped
  // screen — which is WRONG when CC is showing queued user messages.
  //
  // Reproduction (see testbench/scripts/prompt-three-queued.json):
  //   The user submits three prompts in rapid succession. CC enqueues
  //   prompts 2 and 3, then renders its TUI like this:
  //
  //     ❯ say hi in three words
  //     ⏺ Hi there, friend              ← actual assistant response
  //       ❯ now name three colors       ← queued message echo
  //       ❯ finally count one two three ← queued message echo
  //
  //   `last ⏺` lands on the real response, and the slice from there
  //   to the end slurps the queued `❯` lines INTO the assistant block.
  //   The StreamingRow then renders those queued lines as if they
  //   were part of the assistant's answer, which is exactly the
  //   "queue bleeds into rendering" bug the user reported.
  //
  // Fix: scan forward from the assistant marker and stop at the first
  // line that looks like a queued user prompt. Everything from the
  // marker up to (but excluding) that stop line is the real assistant
  // block. If no queued line is found, the walk consumes to the end
  // as before.
  let endIdx = lines.length
  for (let i = lastMarkerIdx + 1; i < lines.length; i++) {
    if (isUserPromptLine(lines[i] ?? '')) {
      endIdx = i
      break
    }
  }

  // Slice from the marker line to the end, then strip the marker itself
  // off the head line so the output reads as plain text.
  const block = lines.slice(lastMarkerIdx, endIdx)
  block[0] = (block[0] ?? '').replace(ASSISTANT_MARKER_RE, '')

  // CC's Ink wrap-aligns subsequent lines of an assistant block to the
  // CONTENT column of the first line. The first line starts with `⏺ `
  // (two visual cells: the marker + a space), so continuation lines get
  // two leading spaces to keep `-` items and paragraph text horizontally
  // aligned under the content, not under the marker. Once we strip `⏺ `
  // off block[0] those two leading spaces on block[1..] become phantom
  // indentation that markdown parsers read as nesting:
  //
  //   `- Python`        ← 0 indent (marker stripped)
  //   `  - JavaScript`  ← 2 indent, looks like nested list
  //   `  - Rust`        ← 2 indent, looks like nested list
  //
  // → react-markdown parses Python as a top-level item with JS and Rust
  // nested under it. Visually wrong, and Tailwind's preflight hides the
  // bullets anyway.
  //
  // Fix: peel off 2 leading spaces from every non-first line that has
  // them. Real semantic 2-space nesting (CC does use 2-space for
  // nested list items via `'  '.repeat(listDepth)`) gets demoted from
  // `    - Nested` → `  - Nested`, which is still valid 2-space nesting
  // relative to the dedented top-level — the geometry is preserved.
  for (let i = 1; i < block.length; i++) {
    const ln = block[i] ?? ''
    if (ln.startsWith('  ')) block[i] = ln.slice(2)
  }

  // Trim trailing blank lines AND divider lines that survived the
  // chrome strip. Blanks are visual padding from CC's layout; dividers
  // are the horizontal rule CC draws between the conversation area
  // and the input box ("────────────────…"). Neither is content.
  //
  // Why this needs to happen here and not in extractStreamingText:
  // extractStreamingText walks from the bottom up until it hits a
  // non-chrome line, which is the "❯ Press up to edit" input hint —
  // and that hint isn't chrome by the isChromeLine definition
  // (it has text after the `❯`). The divider that sits BETWEEN the
  // real assistant text and that hint therefore survives the first
  // strip. The assistant extractor is the right place to drop it
  // because it's the only caller that cares about "just the
  // assistant block" without any surrounding layout.
  while (
    block.length > 0 &&
    ((block[block.length - 1] ?? '').trim() === '' ||
      isDividerLine(block[block.length - 1] ?? ''))
  ) {
    block.pop()
  }

  // Normalize per-line trailing whitespace. CC's Ink pads every rendered
  // line to the terminal column width (120 chars) with trailing spaces.
  // The exact amount of padding can shift between frames depending on
  // layout state, so `extract(screenA) === extract(screenB)` can return
  // false even when the semantic text is identical. This breaks the
  // multi-turn "stale baseline" comparison in App.tsx — the streaming
  // card briefly shows the previous turn's response before the new
  // tokens arrive, because one trailing-space difference flips the
  // comparison from stale → fresh. Strip trailing whitespace per line
  // and the comparison stays stable across Ink's repadding.
  return block.map(l => l.replace(/[ \t]+$/, '')).join('\n')
}

