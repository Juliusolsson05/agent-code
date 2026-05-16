// Incremental extractor for a still-streaming `Write` tool call.
//
// WHY this exists:
//   While a Write tool_use block streams, the renderer only has
//   `block.inputJson` — the raw concatenation of every
//   `input_json_delta.partial_json` fragment the model has emitted so
//   far (see workspace/semantic/foldEvent.ts:421). That string is
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
// WHY a hand-rolled scanner instead of a partial-JSON dependency:
//   1. Write's input shape is fixed and trivial — two known string
//      keys, `file_path` then `content`, in that order. Verified
//      against real proxy dumps: every one of 16 Write calls in a
//      single heavy session matched `{"file_path": "...",
//      "content": "..."}` with whitespace after the colons. A
//      ~150-line targeted scanner is easier to audit than wedging a
//      general partial-JSON parser into the build and trusting its
//      recovery heuristics.
//   2. This runs on every `input_json_delta` — hundreds of times a
//      second on a long write. A single linear pass with no
//      allocation beyond the result keeps it off the profiler.
//   3. The only fiddly part is JSON-string unescape, and that's a
//      fixed spec table we can inline.
//
// WHAT MAKES IT WRONG (invariants):
//   - Assumes key order `file_path` then `content`. If the model
//     ever emits them reversed, `extractStreamingWriteInput` returns
//     `{ filePath: null, partialContent: null }` and the caller
//     falls back to the raw-JSON `<pre>`. It must never throw and
//     must never return a half-unescaped string.
//   - `partialContent` is intentionally returned WITHOUT requiring
//     the closing quote — the whole point is to show the in-flight
//     value. Once the block finalizes, the committed WriteRow
//     renderer takes over and this code is no longer on the path.

export type StreamingWriteInput = {
  /** The `file_path` value, or null if its string literal has not
   *  finished streaming yet (or the buffer didn't match the
   *  expected shape). */
  filePath: string | null
  /** The `content` value decoded so far (JSON-unescaped), or null
   *  if the scanner has not yet reached the start of the `content`
   *  string. Empty string is a valid value — it means `content`
   *  has started but no bytes have arrived. */
  partialContent: string | null
}

const EMPTY: StreamingWriteInput = { filePath: null, partialContent: null }

// JSON single-char escapes (the `\X` forms other than `\uXXXX`).
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

// Decode a JSON string body starting at `start` (the index just
// AFTER the opening quote). Stops at the first unescaped `"` OR at
// end-of-buffer — whichever comes first. Returns the decoded text
// and whether the closing quote was actually seen.
//
// WHY tolerate end-of-buffer: a streaming value's closing quote
// hasn't arrived yet; we still want the bytes decoded so far. If the
// buffer ends mid-escape (a lone trailing `\`, or `\u` with fewer
// than 4 hex digits) we drop that incomplete tail rather than emit
// garbage — the next delta will carry the rest. Real proxy dumps
// show the API does not actually split mid-escape, but relying on
// that would be a latent bug if it ever changed.
function decodeJsonStringBody(
  raw: string,
  start: number,
): { text: string; closed: boolean; end: number } {
  let out = ''
  let i = start
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '"') {
      return { text: out, closed: true, end: i + 1 }
    }
    if (ch === '\\') {
      // Need at least one char after the backslash to know the
      // escape. If it's not here yet, stop — drop the lone `\`.
      if (i + 1 >= raw.length) {
        return { text: out, closed: false, end: i }
      }
      const esc = raw[i + 1]
      if (esc === 'u') {
        // \uXXXX needs 4 hex digits. If fewer have arrived, stop
        // before the `\u` so the partial escape isn't shown raw.
        const hex = raw.slice(i + 2, i + 6)
        if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
          return { text: out, closed: false, end: i }
        }
        out += String.fromCharCode(parseInt(hex, 16))
        i += 6
        continue
      }
      const mapped = SIMPLE_ESCAPES[esc]
      // Unknown escape: keep the literal char (lenient — a malformed
      // escape from the model shouldn't blank the whole preview).
      out += mapped ?? esc
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return { text: out, closed: false, end: i }
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

  // `{`
  let i = skipWs(raw, 0)
  if (raw[i] !== '{') return EMPTY
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

  while (i < raw.length) {
    i = skipWs(raw, i)
    if (i >= raw.length) break
    const ch = raw[i]
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

    const key = decodeJsonStringBody(raw, i + 1)
    // Key literal still streaming → can't know what member this is.
    if (!key.closed) break
    i = key.end

    i = skipWs(raw, i)
    if (raw[i] !== ':') break
    i += 1
    i = skipWs(raw, i)

    // Write's only two args (`file_path`, `content`) are both
    // strings, so a value that doesn't open with `"` is either not
    // here yet or a key we don't care about with a non-string
    // value. Either way we can't reliably skip an arbitrary JSON
    // value with this minimal scanner — stop.
    if (raw[i] !== '"') break

    const value = decodeJsonStringBody(raw, i + 1)
    if (key.text === 'file_path') {
      // file_path is only surfaced once its literal is fully closed
      // — a half path would flicker in the header on every delta.
      if (value.closed) filePath = value.text
    } else if (key.text === 'content') {
      // content is surfaced PARTIAL on purpose — the in-flight value
      // is the whole point of the live preview.
      partialContent = value.text
    }

    // Value still streaming → it's the last member in the buffer;
    // nothing after it to scan.
    if (!value.closed) break
    i = value.end
  }

  return { filePath, partialContent }
}
