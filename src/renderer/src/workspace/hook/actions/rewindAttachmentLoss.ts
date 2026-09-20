import type { RewindSessionAttachment } from '@main/providerSwitch/rewindSession.js'

// ---------------------------------------------------------------------------
// What a rewind could NOT bring back (#1075)
//
// #1073 made main produce a structured loss report for every attachment on a
// rewound prompt, and the Rewind PICKER uses it: an attachment-only turn is
// labelled `[Image prompt]` or `[Attachment unavailable: shot.png]` instead of
// vanishing from the list. Nothing used it AFTER the rewind, so the user acted
// on that label and got a composer with nothing in it and no explanation.
//
// The worst case is not even a broken attachment. Rewinding a Codex, OpenCode
// or Grok image prompt restores the image PERFECTLY and then drops it on the
// way into the composer, because those providers declare
// `supportsImageAttachments: false`. So this reads the report AND the
// provider's capability — a restored image is a loss too, when the composer
// cannot carry it.
//
// WHY the reason is attached to each FILE rather than grouped (#1100 review):
// the first version listed names in attachment order and reasons in category
// order, so a reader pairing them by position paired them wrongly — a PDF read
// as the image and an image as the PDF. Worse, its `unsupported` wording said
// "the composer carries images only" on providers whose composer carries
// NOTHING, and a prompt with one image and one document produced a sentence
// that asserted both halves of a contradiction. One phrase per attachment
// removes both problems and the plural-agreement problem with them.
// ---------------------------------------------------------------------------

/** How many attachments are named before the message stops listing them. */
const NAMED_LIMIT = 2

/**
 * Why an `unavailable` attachment is not here — the one case the composer's
 * capability has nothing to do with, because the bytes were never in the
 * transcript to begin with.
 *
 * Written once: it used to appear in both capability branches, so a change to
 * one of them silently disagreed with the other.
 */
function unavailableReason(attachment: RewindSessionAttachment): string {
  return attachment.reason === 'external-reference'
    ? 'the transcript recorded a reference, not the file'
    : 'the record could not be decoded'
}

function reasonFor(
  attachment: RewindSessionAttachment,
  composerCarriesImages: boolean,
): string | null {
  if (attachment.status === 'unavailable') return unavailableReason(attachment)
  // A composer that carries nothing gives one true answer for every kind, and
  // it is the answer on three of the four providers.
  if (!composerCarriesImages) return 'this provider cannot carry attachments'
  return attachment.status === 'unsupported' ? 'the composer carries images only' : null
}

/**
 * One sentence for the pane toast, or null when everything came back.
 *
 * Each named attachment carries its own reason, so nothing has to be paired by
 * position. Only the first two are named — a toast listing eight filenames is
 * a toast nobody reads — and the tail is counted rather than dropped, because
 * a list that looks complete and is not sends the reader looking for a name
 * that was never printed.
 */
export function describeRewindAttachmentLoss(
  attachments: readonly RewindSessionAttachment[],
  options: { composerCarriesImages: boolean },
): string | null {
  const lost = attachments
    .map(attachment => ({ name: attachment.name, reason: reasonFor(attachment, options.composerCarriesImages) }))
    .filter((entry): entry is { name: string | null; reason: string } => entry.reason !== null)
  if (lost.length === 0) return null

  const subject = lost.length === 1 ? '1 attachment' : `${lost.length} attachments`
  const shown = lost.slice(0, NAMED_LIMIT)
  const phrases = shown.map(entry => (entry.name ? `${entry.name} (${entry.reason})` : entry.reason))
  const hidden = lost.length - shown.length
  const tail = hidden > 0 ? `, and ${hidden} more` : ''
  return `${subject} did not come back: ${phrases.join('; ')}${tail}.`
}
