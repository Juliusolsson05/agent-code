import type { ConversationContent } from 'agent-transcript-parser'

/**
 * What became of one attachment on a rewound prompt (#929).
 *
 * ── WHY A STATUS AND NOT JUST A LIST OF IMAGES ──
 * Rewind reconstructs a prompt the user is about to send again, and the
 * honest answer is not always "here are your images". A provider may have
 * recorded a REFERENCE rather than the bytes, and it may have carried a file
 * the composer cannot hold. Both used to be represented the same way an
 * attachment-free prompt was — by absence — so a prompt whose only content
 * was an image disappeared from the picker entirely and could not be rewound
 * to at all, and a text+image prompt came back silently text-only.
 *
 * ── WHY A REFERENCE IS NEVER FOLLOWED ──
 * `unavailable` is a deliberate refusal, not a missing feature. Re-reading a
 * path recorded weeks ago substitutes whatever is on disk NOW for what was
 * actually sent; the user would resend a different image under the belief
 * that it is the original. Saying the attachment is unavailable is the only
 * truthful option, and it is the acceptance condition in #929: "without
 * substituting changed filesystem bytes".
 */
export type RewindAttachment =
  | { status: 'restored'; mediaType: string; data: string; name: string | null }
  | {
      status: 'unavailable'
      /**
       * `external-reference`: the provider recorded a path or URL instead of
       * the bytes, so the original content is not in the transcript.
       * `unreadable`: the attachment is here but in a shape this cannot decode
       * — a provider change, or a truncated record.
       */
      reason: 'external-reference' | 'unreadable'
      mediaType: string | null
      name: string | null
    }
  | {
      /** The bytes are here, but the composer carries images only. */
      status: 'unsupported'
      mediaType: string | null
      name: string | null
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Split a `data:` URL into its media type and base64 payload.
 *
 * Only base64 data URLs count. A `data:` URL can also be percent-encoded
 * text, which is not an attachment anyone pasted, and treating one as image
 * bytes would hand the composer a payload it cannot decode.
 */
function decodeDataUrl(url: string): { mediaType: string; data: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(url)
  if (!match) return null
  return { mediaType: match[1]!, data: match[2]! }
}

function classify(mediaType: string, data: string, name: string | null): RewindAttachment {
  // A document may be perfectly readable and still not be something the
  // composer can carry. Reporting it as unsupported is what lets the picker
  // say so rather than pretend the prompt had nothing attached.
  return mediaType.startsWith('image/')
    ? { status: 'restored', mediaType, data, name }
    : { status: 'unsupported', mediaType, name }
}

/**
 * Every attachment on a prompt, with what can honestly be done about it.
 *
 * ── WHY ONE FUNCTION FOR ALL PROVIDERS ──
 * Each provider records an attachment differently, but the QUESTION is the
 * same for all of them: are the bytes in the transcript, or only a pointer to
 * them? Before this, only the Claude draft looked at images at all and it did
 * so inline; `plainDraft` — which Codex, OpenCode and Grok all use — returned
 * an empty list unconditionally, so every Codex and OpenCode attachment was
 * invisible to Rewind. A second per-provider copy of this rule is how that
 * asymmetry would come back.
 *
 * Shapes handled, each taken from the decoder that produces it:
 *  - Claude   `{ source: { type: 'base64', media_type, data } }`
 *  - Codex    `{ type: 'input_image', image_url: 'data:…;base64,…' }`
 *             (`image_url` is a plain string in the Codex v2 schema)
 *  - OpenCode `{ type: 'file', mime, filename, url: 'data:…;base64,…' }`
 *
 * Anything else is reported, never dropped: an attachment this cannot read is
 * still an attachment the prompt had, and silence is the failure mode #929 is
 * about.
 */
export function rewindAttachments(content: readonly ConversationContent[]): RewindAttachment[] {
  const attachments: RewindAttachment[] = []
  for (const item of content) {
    if (item.kind !== 'image' && item.kind !== 'document') continue
    if (!isRecord(item.value)) {
      attachments.push({ status: 'unavailable', reason: 'unreadable', mediaType: null, name: null })
      continue
    }
    const value = item.value
    const name = stringField(value, 'filename')

    // Claude: the bytes live under `source`.
    if (isRecord(value.source) && typeof value.source.type === 'string') {
      const source = value.source
      if (source.type === 'base64' && typeof source.data === 'string') {
        attachments.push(classify(stringField(source, 'media_type') ?? 'image/png', source.data, name))
        continue
      }
      // `source.type === 'url'` and anything else: a pointer, not the bytes.
      if (source.type === 'url') {
        attachments.push({
          status: 'unavailable',
          reason: 'external-reference',
          mediaType: stringField(source, 'media_type'),
          name,
        })
        continue
      }
    }

    // Codex (`image_url`) and OpenCode (`url`) both record a URL string; only
    // a data URL carries the content.
    const url = stringField(value, 'image_url') ?? stringField(value, 'url')
    if (url !== null) {
      const decoded = decodeDataUrl(url)
      if (decoded) {
        // OpenCode declares the type separately; trust the declaration over
        // the data URL's own label, because the declaration is what the
        // provider routed the part on.
        attachments.push(classify(stringField(value, 'mime') ?? decoded.mediaType, decoded.data, name))
      } else {
        attachments.push({
          status: 'unavailable',
          reason: 'external-reference',
          mediaType: stringField(value, 'mime'),
          name,
        })
      }
      continue
    }

    attachments.push({
      status: 'unavailable',
      reason: 'unreadable',
      mediaType: stringField(value, 'mime') ?? stringField(value, 'media_type'),
      name,
    })
  }
  return attachments
}

/**
 * How a prompt with no text should be described in the picker.
 *
 * ── WHY THIS EXISTS AT ALL ──
 * `promptsFromSnapshot` drops a prompt whose reconstructed text and images are
 * both empty. That is right for provider scaffolding and wrong for a prompt
 * that WAS an attachment: on Codex and OpenCode an image-only prompt produced
 * no text and no images, so it vanished from the picker and the user could not
 * rewind to it — not even to the turn before it.
 *
 * Returns null when there is genuinely nothing to show.
 */
export function attachmentOnlyLabel(attachments: readonly RewindAttachment[]): string | null {
  if (attachments.length === 0) return null
  const restored = attachments.filter(attachment => attachment.status === 'restored').length
  // The existing label for the case that already worked; kept verbatim so the
  // Claude path's picker rows do not change wording.
  if (restored > 0) return '[Image prompt]'
  // Everything else is a loss, and the row says so rather than implying the
  // attachment is coming back with the prompt.
  return attachments.length === 1
    ? '[Attachment unavailable]'
    : `[${attachments.length} attachments unavailable]`
}
