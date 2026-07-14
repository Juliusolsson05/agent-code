import { decodePartialJsonStringBody } from '@shared/lib/partialJsonString'

// Incremental extractor for a still-streaming `Write` tool call.
//
// WHY this exists:
//   While a Write tool_use block streams, the renderer only has
//   `block.inputJson` — the raw concatenation of every
//   `input_json_delta.partial_json` fragment the model has emitted so
//   far (see session-runtime/semantic/foldEvent.ts:421). That string is
//   almost never valid JSON mid-stream: the `content` string is
//   unterminated, the closing brace is missing, and a fragment can
//   end anywhere — mid-key, mid-value, even mid-escape. So the
//   committed-path trick (`JSON.parse(inputJson)`) cannot run yet.
//
//   To render a live file-write preview we need just two things out
//   of that partial buffer: the file path (once its string literal
//   has closed) and whatever of `content` has arrived so far,
//   already JSON-unescaped so the preview shows real newlines/tabs
//   instead of literal `\n` `\t` pairs. This module does exactly
//   that and nothing more.
//
// WHY a bounded scanner instead of a cache or partial-JSON dependency:
//   1. Write's useful live shape is tiny: a path plus the beginning of one
//      string. A general recovery parser adds ambiguity without improving that
//      contract.
//   2. `inputJson` is the WHOLE accumulated payload on every delta. Re-decoding
//      an unbounded content tail therefore turns a long Write into O(total²)
//      work over its lifetime. This scanner examines a fixed header window and
//      a fixed encoded-content window on every call, so one render has a hard
//      upper bound independent of the eventual file size.
//   3. A module-global memo would hide the repeated work but grow with every
//      operation and complicate replay/cleanup. The bounded pure function is
//      deterministic, naturally garbage-collected with its caller, and still
//      lets the authoritative finalized parse replace the preview exactly.
//
// WHAT MAKES IT WRONG (invariants):
//   - Object members may arrive in either order, but both the key/path and the
//     start of content must appear inside the bounded header window. If a model
//     emits a giant unrelated member first, the result explicitly reports a
//     truncated preview and the exact finalized parse remains the fallback.
//   - `partialContent` is intentionally returned WITHOUT requiring
//     the closing quote — the whole point is to show the in-flight
//     value. It is a PREVIEW, never the source of truth.

/**
 * Hard live-preview bounds. The raw-character cap is intentionally expressed
 * in encoded JSON characters: slicing before decode guarantees the shared
 * decoder cannot inspect an arbitrarily growing tail. Decoded output is never
 * larger than that encoded prefix. The line cap separately prevents a payload
 * made entirely of `\n` escapes from creating thousands of React rows inside a
 * small character budget.
 */
export const STREAMING_WRITE_HEADER_SCAN_CHARS = 4 * 1024
export const STREAMING_WRITE_PREVIEW_RAW_CHARS = 16 * 1024
export const STREAMING_WRITE_PREVIEW_LINES = 400

export type StreamingWriteInput = {
  /** The `file_path`/`filePath`/`path` value, or null if its string literal has not
   *  finished streaming yet (or the buffer didn't match the
   *  expected shape). */
  filePath: string | null
  /** The `content` value decoded so far (JSON-unescaped), or null
   *  if the scanner has not yet reached the start of the `content`
   *  string. Empty string is a valid value — it means `content`
   *  has started but no bytes have arrived. */
  partialContent: string | null
  /** True when a safety bound, rather than the network boundary, stopped the
   *  preview. The UI must say this loudly because a frozen prefix otherwise
   *  looks like the agent stopped writing. */
  previewTruncated: boolean
}

const EMPTY: StreamingWriteInput = {
  filePath: null,
  partialContent: null,
  previewTruncated: false,
}

// Advance past JSON whitespace.
function skipWs(raw: string, i: number): number {
  while (i < raw.length && (raw[i] === ' ' || raw[i] === '\n' || raw[i] === '\r' || raw[i] === '\t')) {
    i += 1
  }
  return i
}

export function extractStreamingWriteInput(inputJson: string): StreamingWriteInput {
  const raw = inputJson
  if (!raw) return EMPTY

  // All structural walking uses this bounded prefix. Content gets its own
  // larger, still-fixed window once its opening quote is located.
  const headerEnd = Math.min(raw.length, STREAMING_WRITE_HEADER_SCAN_CHARS)
  const header = raw.slice(0, headerEnd)

  // `{`
  let i = skipWs(header, 0)
  if (header[i] !== '{') return EMPTY
  i += 1

  // Walk object members in WHATEVER ORDER they arrive. The earlier
  // version of this scanner hard-required `"file_path"` before
  // `"content"` — a positional assumption. JSON object key order is
  // not a contract: the partial-JSON buffer happens to arrive in
  // schema-declaration order today (verified against real proxy
  // dumps), but a positional scanner would silently fall back to
  // raw JSON for an ENTIRE stream if the model ever reordered the
  // keys. Scanning by key name removes that fragility — order no
  // longer matters, and an unexpected extra string-valued key is
  // simply ignored.
  let filePath: string | null = null
  let partialContent: string | null = null
  let previewTruncated = false

  while (i < header.length) {
    i = skipWs(header, i)
    if (i >= header.length) break
    const ch = header[i]
    if (ch === '}') break
    // Tolerate the comma between members (and a stray leading one).
    if (ch === ',') {
      i += 1
      continue
    }
    // Anything that isn't the start of a `"key"` here means the
    // buffer is mid-key or malformed — nothing useful past this
    // point yet. Stop; the next delta will carry more.
    if (ch !== '"') break

    const key = decodePartialJsonStringBody(header, i + 1)
    // Key literal still streaming → can't know what member this is.
    if (!key.closed) break
    i = key.end

    i = skipWs(header, i)
    if (header[i] !== ':') break
    i += 1
    i = skipWs(header, i)

    // Write's only two args (`file_path`, `content`) are both
    // strings, so a value that doesn't open with `"` is either not
    // here yet or a key we don't care about with a non-string
    // value. Either way we can't reliably skip an arbitrary JSON
    // value with this minimal scanner — stop.
    if (header[i] !== '"') break

    if (key.value === 'content') {
      const valueStart = i + 1
      const contentEnd = Math.min(
        raw.length,
        valueStart + STREAMING_WRITE_PREVIEW_RAW_CHARS,
      )
      // Slice from zero so decoder.end remains an absolute index and a short,
      // closed content-first value can continue to a following path member.
      const boundedInput = raw.slice(0, contentEnd)
      const value = decodePartialJsonStringBody(boundedInput, valueStart)
      const capped = capPreviewLines(value.value)
      partialContent = capped.content
      previewTruncated =
        capped.truncated || (!value.closed && raw.length > contentEnd)

      // A capped/open content value may have gigabytes after `contentEnd`; never
      // search that tail for another member. A short closed value can continue
      // only while it remains inside the structural header window.
      if (!value.closed || value.end >= header.length) break
      i = value.end
      continue
    }

    const value = decodePartialJsonStringBody(header, i + 1)
    if (key.value === 'file_path' || key.value === 'filePath' || key.value === 'path') {
      // A path is only surfaced once its literal is fully closed
      // — a half path would flicker in the header on every delta.
      if (value.closed) filePath = value.value
    }

    // An unterminated non-content value at the end of the bounded header may
    // continue far beyond it. Report the cap instead of silently presenting a
    // normal-looking empty preview.
    if (!value.closed) {
      previewTruncated = raw.length > headerEnd
      break
    }
    i = value.end
  }

  if (i >= header.length && raw.length > headerEnd && partialContent === null) {
    previewTruncated = true
  }

  return { filePath, partialContent, previewTruncated }
}

function capPreviewLines(content: string): {
  content: string
  truncated: boolean
} {
  let newlineCount = 0
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] !== '\n') continue
    newlineCount += 1
    if (newlineCount === STREAMING_WRITE_PREVIEW_LINES) {
      const end = index + 1
      return {
        content: content.slice(0, end),
        truncated: end < content.length,
      }
    }
  }
  return { content, truncated: false }
}
