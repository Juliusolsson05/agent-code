import type { RewindSessionAttachment } from '@main/providerSwitch/rewindSession.js'

// ---------------------------------------------------------------------------
// What a rewind could NOT bring back (#1075)
//
// #1073 made main produce a structured loss report for every attachment on a
// rewound prompt, and the Rewind PICKER uses it: an attachment-only turn is
// labelled `[Image prompt]` or `[Attachment unavailable: shot.png]` instead of
// vanishing from the list. Nothing used it AFTER the rewind, so the user acted
// on that label and then got a composer with nothing in it and no explanation.
//
// The worst case is not even a broken attachment. Rewinding a Codex, OpenCode
// or Grok image prompt restores the image PERFECTLY and then drops it on the
// way into the composer, because those providers declare
// `supportsImageAttachments: false`. The picker said `[Image prompt]`; the
// composer is empty; nothing says why. So this reads the report AND the
// provider's capability — a restored image is a loss too, when the composer
// cannot carry it.
// ---------------------------------------------------------------------------

/** Why one attachment is not in the composer. Ordered by how surprising it is
 *  to the person who just clicked the row. */
type LossKind = 'composer-cannot-carry' | 'not-an-image' | 'reference-only' | 'unreadable'

const CLAUSES: Record<LossKind, (count: number) => string> = {
  // The provider restored it and we cannot put it anywhere.
  'composer-cannot-carry': count => `${count === 1 ? 'it is' : 'they are'} an image and this provider's composer cannot carry images`,
  'not-an-image': count => `${count === 1 ? 'it is' : 'they are'} not an image, and the composer carries images only`,
  'reference-only': () => 'the transcript recorded a reference rather than the file',
  'unreadable': () => 'the record could not be decoded',
}

function lossKindOf(
  attachment: RewindSessionAttachment,
  composerCarriesImages: boolean,
): LossKind | null {
  if (attachment.status === 'restored') {
    return composerCarriesImages ? null : 'composer-cannot-carry'
  }
  if (attachment.status === 'unsupported') return 'not-an-image'
  // The IPC shape flattens the union (the bytes are stripped for size), so
  // `reason` is optional here where main's own type makes it required for an
  // unavailable attachment. An absent reason means we cannot say more than
  // "it could not be read", which is the honest default of the two.
  return attachment.reason === 'external-reference' ? 'reference-only' : 'unreadable'
}

/**
 * One sentence for the pane toast, or null when everything came back.
 *
 * WHY it names files but not all of them: a prompt can carry many, and a toast
 * that lists eight filenames is a toast nobody reads. Two names plus a count
 * is enough to recognise WHICH attachment is missing, which is the question a
 * person actually has.
 */
export function describeRewindAttachmentLoss(
  attachments: readonly RewindSessionAttachment[],
  options: { composerCarriesImages: boolean },
): string | null {
  const lost = attachments
    .map(attachment => ({ kind: lossKindOf(attachment, options.composerCarriesImages), name: attachment.name }))
    .filter((entry): entry is { kind: LossKind; name: string | null } => entry.kind !== null)
  if (lost.length === 0) return null

  const named = lost.map(entry => entry.name).filter((name): name is string => name !== null)
  const shown = named.slice(0, 2)
  // The ellipsis tracks what is HIDDEN, not just how many names there are.
  // Three attachments of which two have names would otherwise read
  // "3 attachments (a.png, b.png)" — a list that looks complete and is not,
  // which sends the reader looking for a third name that was never printed.
  const more = lost.length > shown.length
  const subject = `${lost.length === 1 ? '1 attachment' : `${lost.length} attachments`}`
    + (shown.length > 0 ? ` (${shown.join(', ')}${more ? ', …' : ''})` : '')
    + ' did not come back'

  // Grouped by reason, in a stable order, so the same loss always reads the
  // same way — and so a prompt that lost two attachments for two different
  // reasons says both rather than picking one.
  const order: LossKind[] = ['composer-cannot-carry', 'not-an-image', 'reference-only', 'unreadable']
  const clauses = order
    .map(kind => ({ kind, count: lost.filter(entry => entry.kind === kind).length }))
    .filter(group => group.count > 0)
    .map(group => CLAUSES[group.kind](group.count))

  return `${subject}: ${clauses.join('; ')}.`
}
