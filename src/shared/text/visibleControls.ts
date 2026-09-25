/**
 * Make invisible and reordering Unicode visible, for any text a user is asked
 * to APPROVE (#1029, found in #1026's review).
 *
 * THE ATTACK (Trojan Source, CVE-2021-42574): bidirectional overrides and
 * isolates reorder the glyphs a browser draws without changing the bytes a
 * shell runs, so a prompt-injected model can propose a command that READS as
 * harmless and RUNS as something else — the canonical demonstration makes a
 * destructive command appear to be inside a comment. Invisible characters do
 * the same job by hiding a difference rather than reordering one: `./check.sh`
 * and `./check.sh<U+FE0F>` look identical and execute different files
 * (reproduced in #1049's review). A carriage return hides one the same way:
 * a Unix shell treats `./check.sh\r` as a filename whose last byte is CR.
 *
 * WHY escape rather than strip: the approval has to show what will actually
 * run. Deleting the characters would make the modal disagree with the command
 * the provider executes — a second, quieter lie. `⟨U+202E RLO⟩` keeps the
 * string faithful, makes the anomaly obvious, and stays copy-pasteable as a
 * report.
 *
 * WHY the rule is "Unicode says this is invisible" rather than a hand-picked
 * list: the first version enumerated the bidi and zero-width families and was
 * still short by variation selectors, tag characters, Mongolian and Khmer
 * controls, and the invisible math operators — each of which makes two
 * different commands render identically. `Default_Ignorable_Code_Point` is
 * the property Unicode defines for exactly "renders as nothing", so it is the
 * rule, with readable names for the ones a reader will actually meet.
 *
 * NOT for transcript bodies or agent prose. Reordering in a model's answer is
 * cosmetic; reordering in the thing you are about to authorise is the bug.
 */

/** Readable names for the characters a report is likely to contain. */
const NAMED: ReadonlyMap<number, string> = new Map([
  [0x00ad, 'SHY'], [0x034f, 'CGJ'], [0x061c, 'ALM'],
  [0x200b, 'ZWSP'], [0x200c, 'ZWNJ'], [0x200d, 'ZWJ'], [0x200e, 'LRM'], [0x200f, 'RLM'],
  [0x202a, 'LRE'], [0x202b, 'RLE'], [0x202c, 'PDF'], [0x202d, 'LRO'], [0x202e, 'RLO'],
  [0x2060, 'WJ'], [0x2061, 'FUNCTION APPLICATION'], [0x2062, 'INVISIBLE TIMES'],
  [0x2063, 'INVISIBLE SEPARATOR'], [0x2064, 'INVISIBLE PLUS'],
  [0x2066, 'LRI'], [0x2067, 'RLI'], [0x2068, 'FSI'], [0x2069, 'PDI'],
  [0x206a, 'ISS'], [0x206b, 'ASS'], [0x206c, 'IAFS'], [0x206d, 'AAFS'],
  [0x206e, 'NADS'], [0x206f, 'NODS'],
  [0xfeff, 'BOM'],
])

/**
 * Unicode's `Default_Ignorable_Code_Point` ranges (DerivedCoreProperties, 15
 * through 18 — the review compared them and found no later additions).
 * Anything here is defined to render as nothing.
 */
const DEFAULT_IGNORABLE: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c],
  [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f],
  [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f],
  [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff],
  [0xffa0, 0xffa0], [0xfff0, 0xfff8],
  [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a],
  [0xe0000, 0xe0fff],
]

function invisible(code: number): boolean {
  return DEFAULT_IGNORABLE.some(([from, to]) => code >= from && code <= to)
}

/**
 * A carriage return is escaped WHEREVER it appears, including in a CRLF.
 *
 * WHY (#1049 review): "CRLF is just a line ending" is a Windows text
 * assumption, and this text is a command. Bash reads `./check.sh\r\n` as an
 * instruction to run a file whose name ends in CR — the review executed the
 * CR-suffixed file instead of the intended one. A line feed is left alone: it
 * genuinely is the line break the `<pre>` already shows.
 */
const CARRIAGE_RETURN = /\r/g

function marker(code: number): string {
  const name = NAMED.get(code)
  const hex = code.toString(16).toUpperCase().padStart(4, '0')
  return name ? `⟨U+${hex} ${name}⟩` : `⟨U+${hex}⟩`
}

export function containsInvisibleControls(text: string): boolean {
  if (CARRIAGE_RETURN.test(text)) {
    CARRIAGE_RETURN.lastIndex = 0
    return true
  }
  for (const character of text) {
    if (invisible(character.codePointAt(0) ?? -1)) return true
  }
  return false
}

/**
 * The text with every invisible or reordering character replaced by a visible
 * marker: `⟨U+202E RLO⟩`, or `⟨U+FE0F⟩` for one with no short name. Ordinary
 * text, including line feeds, tabs and every script, is returned unchanged.
 */
export function withVisibleControls(text: string): string {
  let out = ''
  for (const character of text) {
    const code = character.codePointAt(0) ?? -1
    out += invisible(code) ? marker(code) : character
  }
  return out.replace(CARRIAGE_RETURN, '⟨U+000D CR⟩')
}
