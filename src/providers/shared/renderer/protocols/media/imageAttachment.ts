import { asRecord } from '@shared/lib/asRecord'

// The single place that decides whether an arbitrary provider node is an image.
//
// WHY this module exists — read this before adding a branch
// ---------------------------------------------------------
// Before it, nothing decided. `codexOutputText` (codex/renderer/transcript/entries.ts)
// and `toolResultContentText` (../rows/toolResultContent.ts) both flatten a tool
// result to `string`, and a `string` return type cannot express "part of this
// result is an image". So an image part fell through to `JSON.stringify(item, null, 2)`
// — the entire multi-megabyte data URL pretty-printed into feed text — and any
// consumer that wanted to show the image had to re-parse the raw content itself.
// Between the two flatteners there are eleven production call sites. Eleven
// places each deciding what an image is, is the distributed-ownership shape that
// docs/rendering/rendering-design-principles.md §1 exists to prevent.
//
// So: this module decides once, at the transcript-mapping boundary, BEFORE
// flattening. Consumers downstream read the already-mapped neutral block; they
// do not call this. See docs/decomposition/image-read-base64-dump.md for the
// isolation contract and the forbidden-importer list.
//
// WHY it recognizes nodes rather than planes
// ------------------------------------------
// The census (docs/decomposition/evidence/image-reads/shape-census.md) found the
// SAME four node shapes at 27 different placements — including five under
// `_atp.source`, where agent-transcript-parser preserves the originating
// provider's shape after a mid-session provider switch. A Claude image read that
// survives a switch to Codex is still Claude-shaped inside a Codex rollout, and
// the reverse also occurs. Keying off "which provider owns this file" would miss
// 56 recorded occurrences across 27 files. Keying off the node's own structure
// handles every placement, including ones nobody has enumerated yet.
//
// WHY every branch cites a census row
// -----------------------------------
// The rule that keeps this module from growing imagined cases: a branch with no
// census row does not get written. If you believe a shape exists, re-run
// `npx tsx scripts/extract-image-shapes.mts` and point at the row.

/** How the image was encoded on the wire. Diagnostic, and the reason a fixture can
 *  assert which recognizer branch fired rather than just that something matched. */
export type ImageOrigin =
  /** `{type:'image', source:{type:'base64', media_type|mimeType, data}}` — census rows 1,3,5,9,10,11,14,15,16,22,23,24,25,26,27 */
  | 'claude-native'
  /** `{type:'input_image', image_url:'data:<mime>;base64,…', detail?}` — census rows 4,8,19,20 */
  | 'codex-data-url'
  /** `toolUseResult.file = {type:'image/*', base64, dimensions?, originalSize?}` — census rows 6,7,17,18,21 */
  | 'claude-sidecar'

export type ImageDimensions = {
  originalWidth?: number
  originalHeight?: number
  displayWidth?: number
  displayHeight?: number
}

export type RecognizedImage = {
  mimeType: string
  /** Raw base64. Never carries a `data:` prefix — base64MediaDataUrl() adds it. */
  data: string
  /** Codex vision-fidelity hint. Observed only as "high"; carried, never branched on. */
  detail?: string
  dimensions?: ImageDimensions
  originalSize?: number
  origin: ImageOrigin
}

export type ResultPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; image: RecognizedImage }

// Cheap structural gate. A data URL must actually declare base64 image content;
// anything else (a remote https URL, a blob:, a future svg+xml inline form) needs
// a different loading and security policy and must not be silently treated as an
// inline payload — that is how a feed starts making outbound requests.
const DATA_URL = /^data:(image\/[a-z0-9.+-]+);base64,/i

function parseDataUrl(value: unknown): { mimeType: string; data: string } | null {
  if (typeof value !== 'string') return null
  const match = DATA_URL.exec(value)
  if (!match) return null
  return {
    mimeType: match[1].toLowerCase(),
    // The prefix is stripped here, once. base64MediaDataUrl() reconstructs it
    // when a disclosure opens. Leaving it on would produce a doubled
    // `data:…;base64,data:…;base64,…` and paint nothing.
    data: value.slice(match[0].length),
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function readDimensions(value: unknown): ImageDimensions | undefined {
  const record = asRecord(value)
  if (!record) return undefined
  const dimensions: ImageDimensions = {
    originalWidth: finiteNumber(record.originalWidth),
    originalHeight: finiteNumber(record.originalHeight),
    displayWidth: finiteNumber(record.displayWidth),
    displayHeight: finiteNumber(record.displayHeight),
  }
  return Object.values(dimensions).some(v => v !== undefined) ? dimensions : undefined
}

/**
 * Recognize a single node as an image, or return null.
 *
 * Returning null is the safe direction: an unrecognized node keeps its existing
 * treatment (an inspectable bounded disclosure), which is visible and
 * diagnosable. Wrongly claiming a node is an image paints a broken <img> and
 * hides whatever it actually was.
 */
export function recognizeImageNode(node: unknown): RecognizedImage | null {
  const record = asRecord(node)
  if (!record) return null

  // ---- codex-data-url ----------------------------------------------------
  // Census rows 4, 8, 19, 20. `detail` is present on the exec-output variant
  // and absent on the user-attachment variant, so it must stay optional — a
  // recognizer that required it would silently drop every Codex attachment.
  if (record.type === 'input_image') {
    const parsed = parseDataUrl(record.image_url)
    if (!parsed) return null
    return {
      mimeType: parsed.mimeType,
      data: parsed.data,
      detail: nonEmptyString(record.detail),
      origin: 'codex-data-url',
    }
  }

  // ---- claude-native -----------------------------------------------------
  // Census rows 1, 3, 5, 9, 10, 11, 14, 15, 16, 22-27. Both MIME spellings are
  // accepted for the same reason observationScope.isNativeImageBlock accepts
  // both: committed Claude blocks use `media_type`, the provider-neutral leaf
  // normalizes to `mimeType`.
  if (record.type === 'image') {
    const source = asRecord(record.source)
    if (!source || source.type !== 'base64') return null
    const mimeType = nonEmptyString(source.media_type) ?? nonEmptyString(source.mimeType)
    const data = nonEmptyString(source.data)
    if (!mimeType || !data) return null
    return { mimeType: mimeType.toLowerCase(), data, origin: 'claude-native' }
  }

  // ---- claude-sidecar ----------------------------------------------------
  // Census rows 6, 7, 17, 18, 21. Here the MIME IS the `type` field
  // (`type: 'image/jpeg'`), which is why this branch is last: it must not
  // shadow the two discriminated-union branches above.
  //
  // The `base64` guard is what keeps the census-row-12 false positive out. That
  // row is Codex's exec tool JSON-Schema — `{image_url, name, path, text, type}`
  // where every value is `{type:'string'}`. It describes an image; it is not
  // one. Requiring an actual string payload rejects every schema-shaped node.
  const sidecarMime = nonEmptyString(record.type)
  const sidecarData = nonEmptyString(record.base64)
  if (sidecarMime?.startsWith('image/') && sidecarData) {
    return {
      mimeType: sidecarMime.toLowerCase(),
      data: sidecarData,
      dimensions: readDimensions(record.dimensions),
      originalSize: finiteNumber(record.originalSize),
      origin: 'claude-sidecar',
    }
  }

  return null
}

/**
 * Split a tool result's content into ordered text and image parts.
 *
 * Returns **null** when the content carries no image at all. That is the signal
 * that lets every existing consumer keep its current string fast path: the
 * overwhelming majority of tool results are plain text, and allocating a parts
 * array for each of them on every render pass would be a real cost on a plane
 * the ledger re-derives every tick (see D11 reference stability in
 * docs/rendering/rendering-design-principles.md §P5).
 *
 * Order is preserved verbatim and parts are never merged, reordered, or dropped.
 * Codex's `exec` returns text(path), image, text(path), image — the text parts
 * are the filenames labelling each image, so position carries meaning that a
 * flattened string destroys.
 */
export function recognizeResultParts(content: unknown): ResultPart[] | null {
  if (!Array.isArray(content) || content.length === 0) return null

  // Two passes, deliberately. The first is a cheap scan that answers "is there
  // an image here at all"; only if there is do we allocate the parts array. This
  // keeps the null fast path genuinely allocation-free rather than building a
  // result and throwing it away.
  let hasImage = false
  for (const item of content) {
    if (recognizeImageNode(item)) {
      hasImage = true
      break
    }
  }
  if (!hasImage) return null

  const parts: ResultPart[] = []
  for (const item of content) {
    const image = recognizeImageNode(item)
    if (image) {
      parts.push({ kind: 'image', image })
      continue
    }
    if (typeof item === 'string') {
      parts.push({ kind: 'text', text: item })
      continue
    }
    const record = asRecord(item)
    const text = record ? nonEmptyString(record.text) : undefined
    // A non-text, non-image sibling keeps a stable placeholder rather than being
    // dropped. Dropping is the failure mode this whole change exists to end: a
    // Codex `input_image` in message content is dropped by rollout.ts today and
    // the user simply never sees their attachment. Showing an honest marker is
    // recoverable; silence is not.
    parts.push({ kind: 'text', text: text ?? `[unrenderable ${record?.type ?? typeof item} part]` })
  }
  return parts
}

/**
 * Read image metadata from Claude's `toolUseResult` sidecar.
 *
 * WHY this is separate from the payload path: Claude records the same image
 * twice — once as a `tool_result` content block (which has the bytes) and once
 * here (which has the bytes AND `dimensions` / `originalSize`). The decision
 * recorded in docs/decomposition/image-read-base64-dump.md is that the PAYLOAD
 * comes from the content block and the METADATA comes from this sidecar, so
 * that a rewind or a provider switch which drops one of the two records
 * degrades gracefully instead of losing the image.
 *
 * Until this change, `toolUseResult` was referenced nowhere in the renderer at
 * all — the dimensions were on disk, unread, while the payload was painted as
 * text.
 */
export function sidecarImageMetadata(toolUseResult: unknown): RecognizedImage | null {
  const record = asRecord(toolUseResult)
  if (!record) return null
  if (record.type !== 'image') return null
  return recognizeImageNode(record.file)
}
