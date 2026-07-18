// The MCP operation caps recovered message text at two million characters, but this parser sees
// the JSON carrier, not only that decoded domain text. A control character can occupy six carrier
// characters (`\u0000`), and the response still needs room for output/message metadata. Sixteen MiB
// therefore admits the owned protocol's worst-case 12 MiB escaped text plus bounded envelope
// overhead while retaining a hard renderer-side parse ceiling. A smaller four-MiB allowance looked
// generous for normal prose but contradicted the server contract for valid control-heavy output.
const MAX_AGENT_CODE_RESULT_CHARS = 16 * 1024 * 1024

/**
 * Parse one result emitted by Agent Code's own MCP server.
 *
 * WHY this does not reuse the generic JSON-row parser: generic provider output must stop before a
 * multi-megabyte JSON.parse on the hot feed path, so that parser intentionally caps itself at
 * 256 KiB. Agent Code's read-agent/read-run-outputs tools, however, explicitly allow callers to
 * request up to two million characters after a smaller read reports truncation. Treating that
 * documented recovery response as an "unrecognized result" made the owned protocol contradict its
 * own server contract. This larger budget is safe only here, after a provider adapter has proven
 * the tool belongs to Agent Code and the result has passed the exact text-carrier gate.
 */
export function parseAgentCodeResultJson(source: string): unknown | null {
  // Check before trim: trimming a provider-controlled two-million-character result would allocate
  // a second large string merely to discover that the input exceeds the owned protocol's ceiling.
  if (source.length === 0 || source.length > MAX_AGENT_CODE_RESULT_CHARS) return null
  const trimmed = source.trim()
  if (trimmed.length === 0) return null

  // Codex historically wrapped MCP output in this deterministic timing envelope. It is transport,
  // not domain evidence, and the exact anchored grammar prevents an arbitrary line containing
  // "Output:" from discarding its prefix.
  const wallTime = /^Wall time: [^\n]*\nOutput:\n([\s\S]*)$/.exec(trimmed)
  const parse = (value: string): unknown | null => {
    const candidate = value.trim()
    if (!candidate.startsWith('{') && !candidate.startsWith('[')) return null
    try {
      return JSON.parse(candidate)
    } catch {
      return null
    }
  }
  let parsed = parse(wallTime ? wallTime[1] : trimmed)
  if (parsed === null) return null

  // Peel only the two exact MCP carrier generations Agent Code emitted. Unknown siblings are
  // semantics, not decoration, and must force generic rendering instead of being erased.
  for (let depth = 0; depth < 3; depth += 1) {
    let text: string | null = null
    if (Array.isArray(parsed) && parsed.length === 1) {
      const item = parsed[0]
      if (
        item !== null &&
        typeof item === 'object' &&
        !Array.isArray(item) &&
        (item as { type?: unknown }).type === 'text' &&
        typeof (item as { text?: unknown }).text === 'string' &&
        Object.keys(item).every(key => key === 'type' || key === 'text')
      ) {
        text = (item as { text: string }).text
      }
    } else if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = parsed as Record<string, unknown>
      const keys = Object.keys(record)
      if (
        keys.every(key => key === 'content' || key === 'isError') &&
        (record.isError === undefined || record.isError === false) &&
        Array.isArray(record.content) &&
        record.content.length === 1
      ) {
        const item = record.content[0]
        if (
          item !== null &&
          typeof item === 'object' &&
          !Array.isArray(item) &&
          (item as { type?: unknown }).type === 'text' &&
          typeof (item as { text?: unknown }).text === 'string' &&
          Object.keys(item).every(key => key === 'type' || key === 'text')
        ) {
          text = (item as { text: string }).text
        }
      }
    }
    if (text === null) break
    const inner = parse(text)
    if (inner === null) return null
    parsed = inner
  }
  return parsed
}

const resultParseCache = new WeakMap<
  ToolResultBlock,
  { source: string; parsed: unknown | null }
>()

/** Parse an immutable transcript result once across dispatch and its owner.
 *
 * WHY this cache is keyed by the block object rather than by the potentially
 * 16 MiB source string: committed dispatch validates a result before it may
 * absorb the generic row, then the mounted owner needs the same parsed value
 * to paint its summary. Repeating trim/JSON.parse/carrier peeling in one paint
 * doubled the largest synchronous allocation. Transcript blocks are
 * immutable, so a WeakMap gives exact invalidation without retaining large
 * sources after their feed entry is released.
 */
export function parseAgentCodeResultBlockJson(
  block: ToolResultBlock,
  source: string,
): unknown | null {
  const cached = resultParseCache.get(block)
  if (cached?.source === source) return cached.parsed
  const parsed = parseAgentCodeResultJson(source)
  resultParseCache.set(block, { source, parsed })
  return parsed
}
import type { ToolResultBlock } from '@shared/types/transcript'
