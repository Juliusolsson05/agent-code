export type PartialJsonString = {
  value: string
  closed: boolean
  end: number
}

const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

/**
 * Decode an in-flight JSON string without requiring its closing quote.
 *
 * WHY this tiny primitive is shared: Write, Edit, and provider-generated patch
 * inputs all need to paint content before JSON.parse can possibly succeed.
 * The incomplete escape tail is deliberately withheld until its remaining
 * bytes arrive; showing a lone backslash or half a unicode code point would
 * make streamed source visibly corrupt and then self-correct a frame later.
 */
export function decodePartialJsonStringBody(
  raw: string,
  start: number,
): PartialJsonString {
  let value = ''
  let index = start
  while (index < raw.length) {
    const char = raw[index]
    if (char === '"') return { value, closed: true, end: index + 1 }
    if (char !== '\\') {
      const codeUnit = char.charCodeAt(0)
      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const next = raw.charCodeAt(index + 1)
        if (Number.isNaN(next)) {
          // Network decoders normally deliver a complete Unicode scalar, but a
          // caller can still hand us a UTF-16 prefix cut between its two code
          // units. Apply the same no-replacement-glyph rule as escaped pairs.
          return { value, closed: false, end: index }
        }
        if (next >= 0xdc00 && next <= 0xdfff) {
          value += char + raw[index + 1]
          index += 2
          continue
        }
      }
      value += char
      index += 1
      continue
    }
    if (index + 1 >= raw.length) return { value, closed: false, end: index }
    const escape = raw[index + 1]
    if (escape === 'u') {
      const hex = raw.slice(index + 2, index + 6)
      if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
        return { value, closed: false, end: index }
      }
      const codeUnit = Number.parseInt(hex, 16)

      if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
        const pairAt = index + 6
        // A high surrogate at the current end of an in-flight buffer is not a
        // renderable character yet. Provider JSON encodes astral characters as
        // two adjacent `\uXXXX` escapes, and publishing the first half paints a
        // replacement glyph which repairs itself one delta later. Withhold the
        // pair until the following bytes prove either a complete low surrogate
        // or that this was intentionally an unpaired JSON code unit.
        if (pairAt >= raw.length || (raw[pairAt] === '\\' && pairAt + 1 >= raw.length)) {
          return { value, closed: false, end: index }
        }
        if (raw[pairAt] === '\\' && raw[pairAt + 1] === 'u') {
          const lowHex = raw.slice(pairAt + 2, pairAt + 6)
          if (lowHex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(lowHex)) {
            return { value, closed: false, end: index }
          }
          const low = Number.parseInt(lowHex, 16)
          if (low >= 0xdc00 && low <= 0xdfff) {
            const codePoint = 0x10000 + ((codeUnit - 0xd800) << 10) + (low - 0xdc00)
            value += String.fromCodePoint(codePoint)
            index += 12
            continue
          }
        }
      }

      value += String.fromCharCode(codeUnit)
      index += 6
      continue
    }
    value += SIMPLE_ESCAPES[escape] ?? escape
    index += 2
  }
  return { value, closed: false, end: index }
}

export function extractPartialJsonStringField(
  raw: string,
  key: string,
): PartialJsonString | null {
  // Provider schemas own these key names; escaping still keeps the helper safe
  // for any future literal key. The negative lookbehind excludes the common
  // false-positive shape where prose contains an escaped `\"key\": \"...`.
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?<!\\\\)"${escaped}"\\s*:\\s*"`).exec(raw)
  if (!match) return null
  return decodePartialJsonStringBody(raw, match.index + match[0].length)
}
