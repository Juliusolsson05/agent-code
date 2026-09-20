/**
 * Make invisible and reordering Unicode visible, for any text a user is asked
 * to APPROVE (#1029, found in #1026's review).
 *
 * THE ATTACK (Trojan Source, CVE-2021-42574): bidirectional overrides and
 * isolates reorder the glyphs a browser draws without changing the bytes a
 * shell runs, so a prompt-injected model can propose a command that READS as
 * harmless and RUNS as something else — the canonical demonstration makes a
 * destructive command appear to be inside a comment. Zero-width characters do
 * the same job by hiding text outright, and a lone `\r` can scroll the
 * dangerous half of a line out of view in a `<pre>`. The permission modal is
 * frequently the only place the command is ever shown, so what it renders IS
 * the user's evidence.
 *
 * WHY escape rather than strip: the approval has to show what will actually
 * run. Deleting the characters would make the modal disagree with the command
 * the provider executes — a second, quieter lie. `⟨U+202E⟩` keeps the string
 * faithful, makes the anomaly obvious, and stays copy-pasteable as a report.
 *
 * WHY not a regex over "suspicious ranges" at each call site: there are three
 * separate families (bidi controls, isolates, invisible formatting) plus the
 * deprecated ones, and any surface that forgot one would silently be the weak
 * link. One table, one helper, every approval surface.
 *
 * NOT for transcript bodies or agent prose. Reordering in a model's answer is
 * cosmetic; reordering in the command you are about to authorise is the bug.
 */

/**
 * Every code point that can reorder or hide neighbouring text.
 *
 * Sources: Unicode 15 Bidirectional Algorithm (explicit formatting), the
 * General_Category=Cf class for the invisible formatting characters, and
 * CVE-2021-42574's published set. Each entry below says what it does, because
 * "it is in a range" is not a reason a future reader can check.
 */
const VISIBLE_CONTROL_CODE_POINTS = new Map<number, string>([
  // Explicit bidi embedding/override — the Trojan Source core.
  [0x202a, 'LRE'], [0x202b, 'RLE'], [0x202c, 'PDF'], [0x202d, 'LRO'], [0x202e, 'RLO'],
  // Bidi isolates: the modern replacement, same reordering power.
  [0x2066, 'LRI'], [0x2067, 'RLI'], [0x2068, 'FSI'], [0x2069, 'PDI'],
  // Implicit marks: weaker, but still flip the order of adjacent runs.
  [0x200e, 'LRM'], [0x200f, 'RLM'], [0x061c, 'ALM'],
  // Invisible: hide or join text without reordering it.
  [0x200b, 'ZWSP'], [0x200c, 'ZWNJ'], [0x200d, 'ZWJ'], [0xfeff, 'BOM'],
  [0x2060, 'WJ'], [0x00ad, 'SHY'],
  // Deprecated shaping/format controls that still render as nothing.
  [0x206a, 'ISS'], [0x206b, 'ASS'], [0x206c, 'IAFS'], [0x206d, 'AAFS'],
  [0x206e, 'NADS'], [0x206f, 'NODS'],
])

/** A lone CR can push the rest of a line out of view in a terminal-styled
 *  block; a real CRLF is left alone because it is just a line ending. */
const LONE_CARRIAGE_RETURN = /\r(?!\n)/g

export function containsInvisibleControls(text: string): boolean {
  if (LONE_CARRIAGE_RETURN.test(text)) {
    LONE_CARRIAGE_RETURN.lastIndex = 0
    return true
  }
  for (const character of text) {
    if (VISIBLE_CONTROL_CODE_POINTS.has(character.codePointAt(0) ?? -1)) return true
  }
  return false
}

/**
 * The text with every reordering or invisible control replaced by a visible
 * marker: `⟨U+202E RLO⟩`. Ordinary text, including real newlines, tabs and
 * every non-Latin script, is returned unchanged.
 */
export function withVisibleControls(text: string): string {
  let out = ''
  for (const character of text) {
    const code = character.codePointAt(0) ?? -1
    const name = VISIBLE_CONTROL_CODE_POINTS.get(code)
    if (name) {
      out += `⟨U+${code.toString(16).toUpperCase().padStart(4, '0')} ${name}⟩`
      continue
    }
    out += character
  }
  return out.replace(LONE_CARRIAGE_RETURN, '⟨U+000D CR⟩')
}
