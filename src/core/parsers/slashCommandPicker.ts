// Slash command picker detection.
//
// Reverse-engineered from CC's render pipeline by reading
// claude-code-src/components/PromptInput/PromptInputFooterSuggestions.tsx:
// each picker row is a <Text color={textColor} dimColor={dimColor}> where
// `dimColor = !isSelected` and `textColor = isSelected ? "suggestion" : undefined`.
// That means the SELECTED row gets a bright "suggestion" palette color
// while the non-selected rows get a muted gray color. Both colors show
// up as SGR palette indices in the @xterm/headless buffer — in the dark
// theme we see fg=153 (selected) and fg=246 (dim) on rows that start
// with `/`.
//
// What we do NOT see in the buffer:
//   - `cell.isDim()` is always 0, even though chalk.dim emits SGR 2.
//     Ink or node-pty is collapsing dim-plus-color into a single
//     palette index before the cell gets stored.
//   - `cell.isBold()` / `cell.isItalic()` / `cell.isInverse()` are all 0.
//
// So the signal we rely on is: "row starts with `/`, first cell has a
// non-default fg color." Every picker row matches. The SELECTED row is
// the one whose fg color is DIFFERENT from the others in the picker
// block. We identify the dim color as the most common one and flip
// `selected` on any row whose color doesn't match. Robust to theme
// changes because the rule uses relative distinction rather than
// hardcoded color values.
//
// This parser runs inside the main process (it takes a Terminal
// instance directly) and its result ships over IPC as part of the
// screen snapshot payload. Can't live in the renderer because we need
// cell-level attribute access that only the Node-side Terminal gives us.

import xtermHeadless from '@xterm/headless'
const { Terminal } = xtermHeadless

type TerminalInstance = InstanceType<typeof Terminal>

export type PickerItem = {
  /** The slash-command name as it appears on screen, e.g. "/init". */
  id: string
  /** Same as id for now; kept as a separate field so future picker
   *  types (file / agent / mcp resource) can have different display
   *  labels vs. stable ids. */
  label: string
  /** Short one-line description CC renders after the padding. */
  description: string
  /** True if this is the row CC is rendering as the current selection. */
  selected: boolean
}

export type SlashPickerState = {
  visible: boolean
  items: PickerItem[]
}

const HIDDEN: SlashPickerState = { visible: false, items: [] }

/**
 * Detect CC's slash command picker from the terminal buffer.
 *
 * Algorithm:
 *   1. Walk every row in the active buffer.
 *   2. A row is a candidate picker row if its first non-space cell
 *      contains `/` AND that cell has a non-default fg color
 *      (fgColorMode !== 0).
 *   3. Parse the row text into `{ id, description }` by splitting on
 *      two-or-more spaces — CC left-pads command names to a fixed
 *      column then puts the description after the padding gap.
 *   4. Collect a tuple `{ id, label, description, fgColor }` for each
 *      candidate row. Track the fg color so we can identify the
 *      selected row later.
 *   5. If we found zero rows the picker isn't visible.
 *   6. Otherwise, find the most common fg color (the "dim" color) and
 *      flip `selected: true` on any row whose color differs. In
 *      practice only one row will differ — the one CC has selected.
 *
 * Contiguity is NOT enforced: even if CC ever adds whitespace or a
 * separator between picker rows, we still pick them up as long as
 * each row follows the "slash + non-default fg" rule.
 */
export function detectSlashPicker(term: TerminalInstance): SlashPickerState {
  const buf = term.buffer.active
  type Candidate = {
    id: string
    label: string
    description: string
    fgColor: number
  }
  const candidates: Candidate[] = []

  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y)
    if (!line) continue

    // Find the first non-space cell in this row. Most rows start at
    // column 0 with content, but we don't assume that — picker rows
    // might be indented for nested pickers in the future.
    let firstCell: ReturnType<typeof line.getCell> | null = null
    for (let x = 0; x < line.length; x++) {
      const c = line.getCell(x)
      if (!c) continue
      const chars = c.getChars()
      if (!chars || chars === ' ') continue
      firstCell = c
      break
    }
    if (!firstCell) continue

    // Must be a forward slash. Other picker types (files, agents,
    // MCP resources) use different leading glyphs — we'll add those
    // in a follow-up when we need them. For now, slash-only.
    if (firstCell.getChars() !== '/') continue

    // Must have a non-default fg color. CC colorizes every picker row
    // (selected = bright suggestion color, non-selected = dim gray),
    // so any picker row will satisfy this. Non-picker rows that
    // happen to start with `/` — like the `❯ /` input prompt row —
    // use the default fg color and get filtered out here.
    if (firstCell.getFgColorMode() === 0) continue

    // Split the row into (name, description). CC renders commands
    // with a run of 2+ spaces between the name column and the
    // description column.
    const raw = line.translateToString(true).replace(/\s+$/, '')
    const parts = raw.split(/\s{2,}/)
    const id = (parts[0] ?? '').trim()
    const description = parts.slice(1).join(' ').trim()
    if (!id || !id.startsWith('/')) continue

    candidates.push({
      id,
      label: id,
      description,
      fgColor: firstCell.getFgColor(),
    })
  }

  if (candidates.length === 0) return HIDDEN

  // Identify the dim color as the most common fg across candidates.
  // In normal operation there's exactly one selected row (different
  // color) and N-1 non-selected rows (dim color). If all rows happen
  // to share a color — unlikely but possible at startup before CC has
  // rendered the selection — we fall through and nothing is marked
  // selected, which is a safe default.
  const counts = new Map<number, number>()
  for (const c of candidates) {
    counts.set(c.fgColor, (counts.get(c.fgColor) ?? 0) + 1)
  }
  let dimColor = candidates[0].fgColor
  let dimCount = 0
  for (const [color, n] of counts) {
    if (n > dimCount) {
      dimCount = n
      dimColor = color
    }
  }

  const items: PickerItem[] = candidates.map(c => ({
    id: c.id,
    label: c.label,
    description: c.description,
    selected: c.fgColor !== dimColor,
  }))

  return { visible: true, items }
}
