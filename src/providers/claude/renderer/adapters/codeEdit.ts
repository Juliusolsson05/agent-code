import { canDiffLinesInline, diffLines, type DiffLine } from '@shared/parsers/lineDiff'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import type {
  CodeEditFile,
  CodeEditRenderModel,
} from '@providers/shared/renderer/protocols/code-edit/model'
import { boundedTextLineCount, boundedTextPage } from '@renderer/lib/text/boundedText'

const MAX_PARTIAL_EDIT_DECODED_CHARS = 16 * 1024
const MAX_PARTIAL_PATH_DECODED_CHARS = 4 * 1024
const MAX_PARTIAL_FIELD_SEARCH_CHARS = 32 * 1024
const MAX_PARTIAL_FIELD_RAW_CHARS = MAX_PARTIAL_EDIT_DECODED_CHARS * 6
const MAX_PARTIAL_EDIT_CONTINUITIES = 64
const PARTIAL_EDIT_CONTINUITY_ANCHOR_CHARS = 512

function boundedSide(
  text: string,
  kind: '-' | '+',
  maxLines: number,
  sourceTruncated = false,
): { lines: DiffLine[]; count: number; previewTruncated: boolean; countTruncated: boolean } {
  const page = boundedTextPage(text, 0, 16 * 1024, maxLines)
  const count = boundedTextLineCount(text)
  const previewLines = text === '' ? [] : page.text.split('\n')
  if (previewLines.length > 0 && previewLines.at(-1) === '' && page.text.endsWith('\n')) {
    previewLines.pop()
  }
  return {
    lines: previewLines.map(line => ({ kind, text: line })),
    // WHY a terminal newline does not count as another +/- row: DiffSlab and
    // diffLines intentionally drop split()'s phantom final empty string. The
    // oversized/Write count must describe the rows the same card paints, or
    // merely crossing the inline-size threshold changes “+1” into “+2”. A
    // truncated scan is only a lower bound, so subtract only when the count is
    // known exact and the final newline is genuinely the end of the source.
    count: count.count - (!sourceTruncated && !count.truncated && text.endsWith('\n') ? 1 : 0),
    previewTruncated: sourceTruncated || page.hasNext,
    countTruncated: sourceTruncated || count.truncated,
  }
}

// Claude wire → CodeEditRenderModel (renderer rewrite, PR #555; Phase 5
// adapter). Claude-PRIVATE: parses Claude's Edit/Write input
// vocabulary and nothing else; Codex has its own adapter and they never
// meet above the shared model (the coupling ban that sank PR #524).
//
// STREAMING-FIRST — the design center, per the product owner's explicit
// trap warning: a model must be paintable from the FIRST closed tokens,
// never gated on the full JSON landing. Two entry points express that:
//   - fromClaudeEditBlock: validated parsed blocks on committed/live planes.
//     A path is mandatory; Edit's still-streaming old/new strings may be empty.
//   - fromClaudePartialEditJson: a RAW partial JSON input string straight
//     off the stream — extracts file_path the moment its string closes and
//     diffs the still-open tail of old_string/new_string in place.

function editFile(
  filePath: string,
  oldString: string,
  newString: string,
  streaming: boolean,
  partialBounds: { oldTruncated?: boolean; newTruncated?: boolean } = {},
): CodeEditFile {
  // canDiffLinesInline is the oversize gate the legacy EditRow used — the
  // LCS diff is quadratic, so past its budget we degrade to an
  // everything-removed/everything-added view instead of freezing the paint.
  // Oversize fallback is BOUNDED (review-noted preservation item: the
  // legacy path used a paged viewer; an uncapped -/+ dump of a huge string
  // would mount unbounded DOM). 200 lines per side + an explicit marker —
  // the full content remains in the transcript/committed views.
  // WHY a capped prefix must not enter LCS: the unscanned suffix can still
  // change which prefix lines match. Presenting that provisional LCS as an
  // exact diff would make additions/deletions disappear merely because more
  // wire bytes became visible. The same remove/add fallback used for
  // oversized committed edits gives us stable prefix evidence, while the
  // truncation flags tell the view that its counts are only lower bounds.
  const sourceTruncated = partialBounds.oldTruncated === true || partialBounds.newTruncated === true
  const inline = !sourceTruncated && canDiffLinesInline(oldString, newString)
  const removed = inline ? null : boundedSide(oldString, '-', 200, partialBounds.oldTruncated)
  const added = inline ? null : boundedSide(newString, '+', 200, partialBounds.newTruncated)
  const lines: DiffLine[] = inline
    ? diffLines(oldString, newString)
    : [...removed!.lines, ...added!.lines]
  const previewTruncated = removed?.previewTruncated === true || added?.previewTruncated === true
  return {
    path: filePath,
    verb: oldString === '' ? 'Creating' : 'Editing',
    lines,
    additions: inline ? lines.filter(l => l.kind === '+').length : added!.count,
    deletions: inline ? lines.filter(l => l.kind === '-').length : removed!.count,
    previewTruncated,
    countsTruncated: removed?.countTruncated === true || added?.countTruncated === true,
    // A streaming cap is not an exact source. Offering these prefixes under
    // an “exact” disclosure would preserve bytes but lie about completeness;
    // only committed oversized inputs can safely expose the paged originals.
    exactSections: previewTruncated && !sourceTruncated
      ? [{ label: 'Before', text: oldString }, { label: 'After', text: newString }]
      : undefined,
    streaming,
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export function fromClaudeEditBlock(
  block: ToolUseBlock,
  opts: { streaming?: boolean; failed?: boolean; errorSummary?: string } = {},
): CodeEditRenderModel | null {
  const input = (block.input ?? {}) as Record<string, unknown>
  const streaming = opts.streaming === true
  const status = opts.failed ? 'failure' : streaming ? 'streaming' : 'success'
  if (block.name === 'Edit') {
    const path = str(input.file_path)
    // WHY committed blank paths decline instead of painting an “Edit” card:
    // the file identity is the minimum evidence that distinguishes an edit
    // operation from malformed provider JSON. Streaming prefixes are admitted
    // separately only after the raw scanner closes a non-blank path.
    if (!streaming && !/\S/.test(path)) return null
    return {
      label: 'Edit',
      files: [editFile(path, str(input.old_string), str(input.new_string), streaming)],
      status,
      errorSummary: opts.errorSummary,
      partial: streaming,
    }
  }
  if (block.name === 'Write') {
    // Honest Write semantics (plan): no known before-state → pure
    // additions, never a fabricated diff.
    const content = str(input.content)
    const path = str(input.file_path)
    if (!streaming && !/\S/.test(path)) return null
    const preview = boundedSide(content, '+', 400)
    return {
      label: 'Write',
      files: [
        {
          path,
          verb: 'Writing',
          lines: preview.lines,
          additions: preview.count,
          deletions: 0,
          previewTruncated: preview.previewTruncated,
          countsTruncated: preview.countTruncated,
          exactSections: preview.previewTruncated ? [{ label: 'Content', text: content }] : undefined,
          streaming,
        },
      ],
      status,
      errorSummary: opts.errorSummary,
      partial: streaming,
    }
  }
  return null // not an edit-family tool — caller falls through to its route
}

/**
 * The invocation card already contains the complete intended Edit/Write. Only
 * the two success acknowledgements actually captured in the frozen corpus are
 * safe to absorb under that card. Name-only suppression used to delete errors,
 * MultiEdit variants with no result fixture, and any future provider payload
 * that happened to reuse these tool names.
 */
export function isClaudeCodeEditSuccessResult(
  result: ToolResultBlock,
  source: ToolUseBlock,
): boolean {
  if (result.tool_use_id !== source.id || result.is_error === true) return false
  if (typeof result.content !== 'string') return false
  if (source.name === 'Edit') {
    return /^The file [^\n]+ has been updated successfully\./.test(result.content)
  }
  if (source.name === 'Write') {
    return /^File created successfully at: [^\n]+/.test(result.content)
  }
  return false
}

/**
 * Pull one JSON string field out of a PARTIAL JSON text. Scans for
 * `"key":"` then decodes escape-aware up to the closing quote or the end
 * of the buffer. `closed` distinguishes "token finished" (safe to trust,
 * e.g. paint the path) from "still streaming" (paint it growing).
 */
export function extractJsonStringField(
  raw: string,
  key: string,
): { value: string; closed: boolean } | null {
  const keyIdx = raw.indexOf(`"${key}"`)
  if (keyIdx === -1) return null
  const colon = raw.indexOf(':', keyIdx + key.length + 2)
  if (colon === -1) return null
  const open = raw.indexOf('"', colon + 1)
  if (open === -1) return null
  let out = ''
  for (let i = open + 1; i < raw.length; i++) {
    const c = raw[i]
    if (c === '\\') {
      const n = raw[i + 1]
      if (n === undefined) return { value: out, closed: false } // escape torn mid-stream
      if (n === 'n') out += '\n'
      else if (n === 't') out += '\t'
      else if (n === 'r') out += '\r'
      else if (n === 'b') out += '\b'
      else if (n === 'f') out += '\f'
      else if (n === 'u') {
        const hex = raw.slice(i + 2, i + 6)
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16))
          i += 4
        } else {
          // WHY malformed \u is consumed only as an unknown one-character
          // escape: skipping four arbitrary bytes swallowed a closing quote,
          // so malformed complete JSON looked like an endlessly open prefix.
          // Keeping the same tolerant “drop the slash” policy as other
          // unknown escapes preserves streamed evidence and still lets the
          // delimiter close the field on the next iterations.
          out += n
        }
      } else out += n
      i += 1
      continue
    }
    if (c === '"') return { value: out, closed: true }
    out += c
  }
  return { value: out, closed: false }
}

type BoundedJsonStringField = {
  value: string
  closed: boolean
  /** True means either raw bytes or decoded output were deliberately left
   * unread. False with `closed: false` means only that the stream has not
   * delivered the closing quote yet. */
  truncated: boolean
}

type BoundedJsonStringSearch = {
  field: BoundedJsonStringField | null
  /** The key may exist in the deliberately skipped middle of a large input. */
  searchTruncated: boolean
}

type PartialEditContinuity = {
  rawLength: number
  headAnchor: string
  tailAnchor: string
  newField: BoundedJsonStringField | null
}

// WHY a tiny continuity cache is necessary even though adapters are normally
// pure: a bounded head+tail scan has an information-theoretic blind spot. Once
// a large `new_string` grows by more than the tail window, its key sits in the
// deliberately unread middle. Replacing a previously visible addition with
// an empty string at that point makes truthful evidence disappear. Scanning
// the whole accumulated JSON would fix the symptom by making every streamed
// paint O(total input), and therefore the full stream quadratic.
//
// The cache retains only the already-bounded decoded prefix and two 512-char
// anchors. A value is reused only when the next buffer proves it extends the
// exact prior tail at the exact prior offset and preserves the same head. This
// is stronger than matching a path: interleaved or restarted edits of the same
// file reset instead of borrowing each other's content. The map is capped so
// abandoned semantic blocks cannot turn renderer continuity into an unbounded
// session-lifetime allocation. A future adapter API carrying toolUseId should
// replace the path key, but the byte-continuation proof remains required even
// then because providers can reuse correlation ids after replay/rewind.
const partialEditContinuities = new Map<string, PartialEditContinuity>()

function continuedPartialEdit(
  key: string,
  raw: string,
): PartialEditContinuity | null {
  const previous = partialEditContinuities.get(key)
  if (!previous || raw.length < previous.rawLength) return null
  if (!raw.startsWith(previous.headAnchor)) return null
  const anchorStart = previous.rawLength - previous.tailAnchor.length
  return raw.slice(anchorStart, previous.rawLength) === previous.tailAnchor
    ? previous
    : null
}

function rememberPartialEdit(
  key: string,
  raw: string,
  newField: BoundedJsonStringField | null,
): void {
  // Refresh insertion order so the fixed-size map behaves as a small LRU.
  partialEditContinuities.delete(key)
  partialEditContinuities.set(key, {
    rawLength: raw.length,
    headAnchor: raw.slice(0, PARTIAL_EDIT_CONTINUITY_ANCHOR_CHARS),
    tailAnchor: raw.slice(-PARTIAL_EDIT_CONTINUITY_ANCHOR_CHARS),
    newField: newField ? { ...newField } : null,
  })
  while (partialEditContinuities.size > MAX_PARTIAL_EDIT_CONTINUITIES) {
    const oldest = partialEditContinuities.keys().next().value as string | undefined
    if (oldest === undefined) break
    partialEditContinuities.delete(oldest)
  }
}

function findNeedleInWindow(raw: string, needle: string, start: number, end: number): number {
  const lastStart = end - needle.length
  for (let index = start; index <= lastStart; index += 1) {
    // A quote escaped inside a preceding string cannot begin an object key.
    // Rejecting it also prevents a tail window from mistaking generated source
    // text such as `\"new_string\":` for Claude's actual input member.
    if (raw[index - 1] === '\\') continue
    if (raw.startsWith(needle, index)) return index
  }
  return -1
}

function findBoundedFieldKey(raw: string, key: string): { index: number; searchTruncated: boolean } {
  const needle = `"${key}"`
  const headEnd = Math.min(raw.length, MAX_PARTIAL_FIELD_SEARCH_CHARS)
  const headIndex = findNeedleInWindow(raw, needle, 0, headEnd)
  const tailStart = Math.max(headEnd, raw.length - MAX_PARTIAL_FIELD_SEARCH_CHARS)
  const searchTruncated = tailStart > headEnd
  if (headIndex >= 0) return { index: headIndex, searchTruncated }
  const tailIndex = findNeedleInWindow(raw, needle, tailStart, raw.length)
  return { index: tailIndex, searchTruncated }
}

function extractBoundedPartialJsonStringField(
  raw: string,
  key: string,
  maxDecodedChars: number,
): BoundedJsonStringSearch {
  const found = findBoundedFieldKey(raw, key)
  if (found.index < 0) return { field: null, searchTruncated: found.searchTruncated }

  // WHY syntax lookahead has its own tiny ceiling: `indexOf(':')` and
  // `indexOf('"')` silently scan the rest of an ever-growing payload. Claude's
  // object grammar puts only whitespace between key, colon, and string quote;
  // hundreds of bytes there are malformed evidence and belong to fallback,
  // not a reason to spend renderer work proportional to the whole buffer.
  const syntaxEnd = Math.min(raw.length, found.index + key.length + 2 + 256)
  let cursor = found.index + key.length + 2
  while (cursor < syntaxEnd && /[\t\n\r ]/.test(raw[cursor])) cursor += 1
  if (raw[cursor] !== ':') return { field: null, searchTruncated: found.searchTruncated }
  cursor += 1
  while (cursor < syntaxEnd && /[\t\n\r ]/.test(raw[cursor])) cursor += 1
  if (raw[cursor] !== '"') return { field: null, searchTruncated: found.searchTruncated }
  cursor += 1

  let out = ''
  const rawEnd = Math.min(raw.length, cursor + MAX_PARTIAL_FIELD_RAW_CHARS)
  for (let index = cursor; index < rawEnd;) {
    const c = raw[index]
    // Check the delimiter before the output budget so an exactly-16-KiB,
    // already-closed value remains exact rather than being mislabeled capped.
    if (c === '"') {
      return {
        field: { value: out, closed: true, truncated: false },
        searchTruncated: found.searchTruncated,
      }
    }
    if (out.length >= maxDecodedChars) {
      return {
        field: { value: out, closed: false, truncated: true },
        searchTruncated: found.searchTruncated,
      }
    }
    if (c !== '\\') {
      out += c
      index += 1
      continue
    }

    const escaped = raw[index + 1]
    if (escaped === undefined || index + 1 >= rawEnd) {
      return {
        field: {
          value: out,
          closed: false,
          truncated: rawEnd < raw.length,
        },
        searchTruncated: found.searchTruncated,
      }
    }
    if (escaped === 'u') {
      const hex = raw.slice(index + 2, Math.min(index + 6, rawEnd))
      if (/^[0-9a-fA-F]{4}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16))
        index += 6
        continue
      }
      // Match the tolerant public extractor: malformed unicode consumes only
      // the slash, leaving all potential delimiters available to the scanner.
      out += escaped
      index += 2
      continue
    }
    if (escaped === 'n') out += '\n'
    else if (escaped === 't') out += '\t'
    else if (escaped === 'r') out += '\r'
    else if (escaped === 'b') out += '\b'
    else if (escaped === 'f') out += '\f'
    else out += escaped
    index += 2
  }

  return {
    field: {
      value: out,
      closed: false,
      truncated: rawEnd < raw.length,
    },
    searchTruncated: found.searchTruncated,
  }
}

/** RAW streaming input JSON → model, ASAP. Returns null until the tool is
 *  recognizable as edit-family AND file_path has CLOSED (the earliest
 *  honest paint point — a half-streamed path must not render). */
export function fromClaudePartialEditJson(
  toolName: string,
  rawInputJson: string,
): CodeEditRenderModel | null {
  if (toolName !== 'Edit' && toolName !== 'Write') return null
  // WHY every field uses the bounded scanner here instead of the convenient
  // public extractor above: semantic inputJson is the complete accumulated
  // prefix and this adapter runs on every delta. Fully decoding a megabyte
  // Write (or scanning through old_string to find new_string) on every paint
  // turns streaming into quadratic renderer work. Head+tail key windows retain
  // the normal Claude order and the useful growing tail without ever scanning
  // the skipped middle; 16 KiB decoded per side is the live preview contract.
  const pathSearch = extractBoundedPartialJsonStringField(
    rawInputJson,
    'file_path',
    MAX_PARTIAL_PATH_DECODED_CHARS,
  )
  const path = pathSearch.field
  if (!path || !path.closed || path.truncated || !/\S/.test(path.value)) return null
  if (toolName === 'Write') {
    const contentSearch = extractBoundedPartialJsonStringField(
      rawInputJson,
      'content',
      MAX_PARTIAL_EDIT_DECODED_CHARS,
    )
    const content = contentSearch.field
    const contentTruncated = content?.truncated === true || (!content && contentSearch.searchTruncated)
    const preview = boundedSide(content?.value ?? '', '+', 400, contentTruncated)
    return {
      label: 'Write',
      files: [{
        path: path.value,
        verb: 'Writing',
        lines: preview.lines,
        additions: preview.count,
        deletions: 0,
        previewTruncated: preview.previewTruncated,
        countsTruncated: preview.countTruncated,
        streaming: true,
      }],
      status: 'streaming',
      partial: true,
    }
  }
  const oldSearch = extractBoundedPartialJsonStringField(
    rawInputJson,
    'old_string',
    MAX_PARTIAL_EDIT_DECODED_CHARS,
  )
  const newSearch = extractBoundedPartialJsonStringField(
    rawInputJson,
    'new_string',
    MAX_PARTIAL_EDIT_DECODED_CHARS,
  )
  const oldS = oldSearch.field
  const continuityKey = `${toolName}\0${path.value}`
  const previous = continuedPartialEdit(continuityKey, rawInputJson)
  // WHY reuse is restricted to the scanner's skipped-middle case: before the
  // key arrives, `field: null` is honest evidence that there is no after-side
  // yet. Only a proven extension of a buffer where the key was already seen
  // may carry that bounded prefix forward. This preserves monotonic evidence
  // without inventing additions while Claude is still streaming old_string.
  const retainedNew = !newSearch.field && newSearch.searchTruncated
    ? previous?.newField ?? null
    : null
  const newS = newSearch.field ?? retainedNew
  rememberPartialEdit(continuityKey, rawInputJson, newS)
  return {
    label: 'Edit',
    files: [editFile(path.value, oldS?.value ?? '', newS?.value ?? '', true, {
      oldTruncated: oldS?.truncated === true || (!oldS && oldSearch.searchTruncated),
      newTruncated:
        retainedNew !== null ||
        newS?.truncated === true ||
        (!newS && newSearch.searchTruncated),
    })],
    status: 'streaming',
    partial: true,
  }
}
