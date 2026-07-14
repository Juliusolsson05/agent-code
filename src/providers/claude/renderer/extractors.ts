// Pure data extractors for Claude wire shapes — NO JSX. The artifact
// resolve layer (src/renderer/src/features/feed/ui/resolve/) calls
// these to normalize provider-specific payloads into ArtifactVMs; the
// cards never see provider wire shapes. Keeping extraction here (and
// JSX out) is the provider seam of the 2026-07 RENDER rewrite: a
// provider can never fork the visual language again, only feed it.

/** Parsed slash-command invocation envelope. Claude Code records a
 *  slash command as a user text block containing XML-ish tags. */
export type SlashCommandEnvelope = {
  name: string
  message: string | null
  args: string | null
}

// WHY order-insensitive per-tag regexes instead of one combined match:
// verified against real transcripts (2026-07-11) — the tag ORDER
// VARIES between Claude Code versions: older sessions emit
// <command-name> first, newer ones emit <command-message> first. A
// positional grammar would silently stop matching on the next
// upstream shuffle. Tags are single-occurrence per block in every
// observed sample; [\s\S] because <command-args> carries raw user
// text including newlines.
const COMMAND_NAME_RE = /<command-name>([\s\S]*?)<\/command-name>/
const COMMAND_MESSAGE_RE = /<command-message>([\s\S]*?)<\/command-message>/
const COMMAND_ARGS_RE = /<command-args>([\s\S]*?)<\/command-args>/
const LOCAL_STDOUT_RE = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/

/** Parse a user text block that is a slash-command invocation.
 *  Returns null when the block carries no <command-name> tag —
 *  callers fall through to normal user-text rendering, so this can
 *  never make a prompt LESS readable. */
export function parseSlashCommandEnvelope(text: string): SlashCommandEnvelope | null {
  const name = COMMAND_NAME_RE.exec(text)?.[1]?.trim()
  if (!name) return null
  const message = COMMAND_MESSAGE_RE.exec(text)?.[1]?.trim() || null
  const args = COMMAND_ARGS_RE.exec(text)?.[1]?.trim() || null
  return { name, message, args }
}

/** Parse a user text block that is ONLY a local-command stdout record
 *  (Claude Code emits it as a SEPARATE user entry following the
 *  invocation). Content may carry ANSI escapes — real sample:
 *  "Set model to \x1b[1mFable 5\x1b[22m…" — so render it through an
 *  ANSI-aware surface. Returns null when the tag is absent. */
export function parseLocalCommandStdout(text: string): string | null {
  const m = LOCAL_STDOUT_RE.exec(text)
  if (!m) return null
  return m[1] ?? ''
}

/** Does this user text block belong to the slash-command surface at
 *  all (invocation OR stdout record)? Cheap gate so the hot user-text
 *  path doesn't run three regexes on every ordinary prompt. */
export function isSlashCommandText(text: string): boolean {
  return text.includes('<command-name>') || text.includes('<local-command-stdout>')
}

// ---------------------------------------------------------------------------
// Edit / MultiEdit / Write input extraction (committed + live-partial)
// ---------------------------------------------------------------------------

import {
  decodePartialJsonStringBody,
  extractPartialJsonStringField,
} from '@shared/lib/partialJsonString'

/** Committed Edit input — missing fields become empty strings so the
 *  diff still renders (as all-added / all-removed) without crashing.
 *  Moved from ClaudeRows.tsx editInput. */
export function editInput(input: unknown): {
  filePath: string
  oldString: string
  newString: string
} {
  const rec = (input ?? {}) as Record<string, unknown>
  return {
    // Claude uses snake_case; OpenCode's evidence-backed edit/write parts use
    // camelCase. The presentation VM is deliberately provider-neutral, so
    // normalize those two observed spellings here instead of forking DiffCard.
    filePath:
      typeof rec.file_path === 'string'
        ? rec.file_path
        : typeof rec.filePath === 'string'
          ? rec.filePath
          : '',
    oldString:
      typeof rec.old_string === 'string'
        ? rec.old_string
        : typeof rec.oldString === 'string'
          ? rec.oldString
          : '',
    newString:
      typeof rec.new_string === 'string'
        ? rec.new_string
        : typeof rec.newString === 'string'
          ? rec.newString
          : '',
  }
}

export function multiEditInput(input: unknown): {
  filePath: string
  edits: Array<{ oldString: string; newString: string }>
} {
  const rec = (input ?? {}) as Record<string, unknown>
  const edits = Array.isArray(rec.edits) ? (rec.edits as Array<Record<string, unknown>>) : []
  return {
    filePath:
      typeof rec.file_path === 'string'
        ? rec.file_path
        : typeof rec.filePath === 'string'
          ? rec.filePath
          : '',
    edits: edits.map(e => ({
      oldString:
        typeof e.old_string === 'string'
          ? e.old_string
          : typeof e.oldString === 'string'
            ? e.oldString
            : '',
      newString:
        typeof e.new_string === 'string'
          ? e.new_string
          : typeof e.newString === 'string'
            ? e.newString
            : '',
    })),
  }
}

// [#285] Extract a CLOSED top-level JSON string field from a partial
// inputJson buffer — one whose closing quote has already streamed. This
// compatibility helper remains useful to focused callers/tests, but the hot
// Edit projection below deliberately uses the bounded structural scanner: a
// regex against the complete accumulated buffer has no per-delta cost bound.
export function extractClosedJsonString(raw: string, key: string): string | null {
  const value = extractPartialJsonStringField(raw, key)
  return value?.closed ? value.value : null
}

/**
 * Hard bounds for the provisional Edit/MultiEdit decoder.
 *
 * WHY these are provider-side rather than React-side: by the time a card owns a
 * `Record<string, unknown>`, an unbounded decoder has already paid to search and
 * unescape the whole accumulated JSON prefix. The renderer receives the entire
 * prefix again on every provider delta, so even a linear full scan is quadratic
 * over the life of a large edit. Slicing before structural scanning makes the
 * cost of one projection independent of the final replacement size.
 *
 * The exact parsed object always bypasses these limits. These are only limits on
 * what we predict while JSON is incomplete, never limits on committed evidence.
 */
export const STREAMING_EDIT_HEADER_SCAN_CHARS = 4 * 1024
export const STREAMING_EDIT_PREVIEW_RAW_CHARS = 32 * 1024
export const STREAMING_EDIT_PREVIEW_LINES = 400
export const STREAMING_MULTI_EDIT_PREVIEW_ITEMS = 32

export type PartialEditPreview = {
  input: Record<string, unknown> | null
  /** True means a safety limit, rather than the provider boundary, froze the
   * provisional view. Callers must label that state; a silent frozen diff looks
   * exactly like the model stopped producing an edit. */
  previewTruncated: boolean
}

type ScannedString = {
  value: string
  closed: boolean
}

type ScannedEditItem = {
  oldString: ScannedString | null
  newString: ScannedString | null
}

function skipPartialJsonWhitespace(raw: string, index: number): number {
  while (
    index < raw.length &&
    (raw[index] === ' ' || raw[index] === '\n' || raw[index] === '\r' || raw[index] === '\t')
  ) {
    index += 1
  }
  return index
}

function isFilePathKey(key: string): boolean {
  return key === 'file_path' || key === 'filePath'
}

function isOldStringKey(key: string): boolean {
  return key === 'old_string' || key === 'oldString'
}

function isNewStringKey(key: string): boolean {
  return key === 'new_string' || key === 'newString'
}

/**
 * Decode one object containing only the string fields we need.
 *
 * WHY this is a structural walk instead of three regexes: old/new source can
 * legitimately contain text such as `"new_string": "..."`. A regex over the
 * whole partial buffer cannot prove that a key-shaped substring is outside a
 * JSON string. Walking quotes once also means completed MultiEdit items are not
 * sliced and decoded a second time for every key.
 */
function scanEditItem(
  bounded: string,
  objectStart: number,
): { item: ScannedEditItem; end: number; closed: boolean } {
  let index = objectStart + 1
  let oldString: ScannedString | null = null
  let newString: ScannedString | null = null

  while (index < bounded.length) {
    index = skipPartialJsonWhitespace(bounded, index)
    if (bounded[index] === ',') {
      index += 1
      continue
    }
    if (bounded[index] === '}') {
      return { item: { oldString, newString }, end: index + 1, closed: true }
    }
    if (bounded[index] !== '"') break

    const key = decodePartialJsonStringBody(bounded, index + 1)
    if (!key.closed) break
    index = skipPartialJsonWhitespace(bounded, key.end)
    if (bounded[index] !== ':') break
    index = skipPartialJsonWhitespace(bounded, index + 1)

    // Edit item schemas contain only the two source strings. Stopping on an
    // unknown/non-string value is intentional: guessing how to skip arbitrary
    // partial JSON would turn this bounded predictor into a recovery parser.
    // The next delta or authoritative finalized parse remains the source of
    // truth for shapes outside the observed provider contract.
    if (bounded[index] !== '"') break
    const value = decodePartialJsonStringBody(bounded, index + 1)
    const scanned = { value: value.value, closed: value.closed }
    if (isOldStringKey(key.value)) oldString = scanned
    if (isNewStringKey(key.value)) newString = scanned
    index = value.end
    if (!value.closed) break
  }

  return { item: { oldString, newString }, end: index, closed: false }
}

function scanMultiEditArray(
  bounded: string,
  arrayStart: number,
): {
  items: ScannedEditItem[]
  end: number
  closed: boolean
  itemLimitReached: boolean
} {
  const items: ScannedEditItem[] = []
  let index = arrayStart + 1

  while (index < bounded.length) {
    index = skipPartialJsonWhitespace(bounded, index)
    if (bounded[index] === ',') {
      index += 1
      continue
    }
    if (bounded[index] === ']') {
      return {
        items,
        end: index + 1,
        closed: true,
        itemLimitReached: false,
      }
    }
    if (bounded[index] !== '{') break

    if (items.length >= STREAMING_MULTI_EDIT_PREVIEW_ITEMS) {
      // Even zero-length edits can otherwise create thousands of cards inside
      // the fixed character window. The item limit is a DOM bound, while the
      // character limit is a decoder/CPU bound; both are required.
      return {
        items,
        end: index,
        closed: false,
        itemLimitReached: true,
      }
    }

    const scanned = scanEditItem(bounded, index)
    if (scanned.item.oldString !== null || scanned.item.newString !== null) {
      items.push(scanned.item)
    }
    index = scanned.end
    if (!scanned.closed) break
  }

  return {
    items,
    end: index,
    closed: false,
    itemLimitReached: false,
  }
}

/**
 * Build a bounded prediction of an in-flight Edit/MultiEdit input.
 *
 * The parser accepts both observed snake_case (Claude) and camelCase
 * (OpenCode) spellings, but always returns the neutral snake_case shape already
 * understood by `editInput`/`multiEditInput`. Inferring field spelling from the
 * capitalization of a tool name was not a protocol invariant and made a lower-
 * case tool carrying snake_case data decode as empty strings.
 */
export function partialEditPreview(
  raw: string,
  parsed: Record<string, unknown> | null,
  toolName: string,
): PartialEditPreview {
  if (parsed) return { input: parsed, previewTruncated: false }
  if (!raw) return { input: null, previewTruncated: false }

  const scanLimit = STREAMING_EDIT_HEADER_SCAN_CHARS + STREAMING_EDIT_PREVIEW_RAW_CHARS
  const bounded = raw.slice(0, scanLimit)
  const cutByCharacterLimit = raw.length > bounded.length
  const multiEdit = toolName.toLowerCase() === 'multiedit'

  let index = skipPartialJsonWhitespace(bounded, 0)
  if (bounded[index] !== '{') {
    return { input: null, previewTruncated: cutByCharacterLimit }
  }
  index += 1

  let filePath: string | null = null
  let oldString: ScannedString | null = null
  let newString: ScannedString | null = null
  let edits: ScannedEditItem[] = []
  let editsClosed = false
  let itemLimitReached = false

  while (index < bounded.length) {
    index = skipPartialJsonWhitespace(bounded, index)
    if (bounded[index] === ',') {
      index += 1
      continue
    }
    if (bounded[index] === '}') break
    if (bounded[index] !== '"') break

    const key = decodePartialJsonStringBody(bounded, index + 1)
    if (!key.closed) break
    index = skipPartialJsonWhitespace(bounded, key.end)
    if (bounded[index] !== ':') break
    index = skipPartialJsonWhitespace(bounded, index + 1)

    if (key.value === 'edits' && multiEdit) {
      if (bounded[index] !== '[') break
      const array = scanMultiEditArray(bounded, index)
      edits = array.items
      editsClosed = array.closed
      itemLimitReached = array.itemLimitReached
      index = array.end
      if (!array.closed) break
      continue
    }

    if (
      !isFilePathKey(key.value) &&
      !isOldStringKey(key.value) &&
      !isNewStringKey(key.value)
    ) {
      // The useful fields in observed Edit inputs precede optional booleans
      // such as replace_all. Once an unknown value appears, stop rather than
      // recursively interpreting arbitrary partial JSON. If providers reorder
      // such a member before the edit fields, the explicit capped/receiving
      // surface remains honest until finalized parsing supplies the exact data.
      break
    }
    if (bounded[index] !== '"') break

    const value = decodePartialJsonStringBody(bounded, index + 1)
    const scanned = { value: value.value, closed: value.closed }
    if (isFilePathKey(key.value) && value.closed) filePath = value.value
    if (isOldStringKey(key.value)) oldString = scanned
    if (isNewStringKey(key.value)) newString = scanned
    index = value.end
    if (!value.closed) break
  }

  const relevantInputComplete = multiEdit
    ? editsClosed
    : oldString?.closed === true && newString?.closed === true
  const previewTruncated =
    itemLimitReached || (cutByCharacterLimit && !relevantInputComplete)

  if (!filePath) return { input: null, previewTruncated }
  if (multiEdit) {
    return {
      input: {
        file_path: filePath,
        edits: edits.map(item => ({
          old_string: item.oldString?.value ?? '',
          new_string: item.newString?.value ?? '',
        })),
      },
      previewTruncated,
    }
  }
  return {
    input: {
      file_path: filePath,
      old_string: oldString?.value ?? '',
      new_string: newString?.value ?? '',
    },
    previewTruncated,
  }
}

// [#285] Build the committed Edit/MultiEdit input object from a live
// partial buffer, so the streaming path renders the SAME diff card the
// committed transcript uses. Returns null until at least file_path has
// streamed — never flash an empty "(no changes)" card. Moved from
// BlockRow.tsx claudeLiveEditInput.
export function partialEditInput(
  raw: string,
  parsed: Record<string, unknown> | null,
  toolName: string,
): Record<string, unknown> | null {
  return partialEditPreview(raw, parsed, toolName).input
}
