import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { classifyClaudeRecord, decodeClaudeConversation, decodeCodexConversation } from 'agent-transcript-parser'
import type { ConversationContent } from 'agent-transcript-parser'
import { rewindAttachments } from '@main/providerSwitch/rewindAttachments.js'
import { toRewindSessionAttachments } from '@main/providerSwitch/rewindSession.js'
import type { RewindSessionAttachment } from '@main/providerSwitch/rewindSession.js'

import { describeRewindAttachmentLoss } from './rewindAttachmentLoss'

// ---------------------------------------------------------------------------
// #1075. Main has produced a loss report for every attachment on a rewound
// prompt since #1073, and the Rewind PICKER uses it — an attachment-only turn
// is labelled `[Image prompt]` or `[Attachment unavailable: shot.png]` instead
// of vanishing. Nothing used it AFTER the rewind, so a user clicked that row
// and got a composer with nothing in it and no explanation.
//
// The sharpest case has no broken attachment at all: rewinding a Codex,
// OpenCode or Grok image prompt restores the image perfectly and then drops it
// on the way into the composer, because those providers declare
// `supportsImageAttachments: false`.
//
// The reports below are built by the REAL `rewindAttachments` from REAL
// recorded content (`testing/fixtures/image-reads/`, captured verbatim from
// live sessions with only the base64 swapped for a 1x1 PNG), then flattened by
// the REAL `toRewindSessionAttachments` — the same two functions that produce
// what crosses IPC.
// ---------------------------------------------------------------------------

const fixture = (name: string): Record<string, unknown> => JSON.parse(
  readFileSync(resolve(__dirname, `../../../../../../testing/fixtures/image-reads/${name}.json`), 'utf8'),
) as Record<string, unknown>

function codexUserContent(entry: Record<string, unknown>): ConversationContent[] {
  const document = decodeCodexConversation([{
    line: 1,
    raw: entry,
    family: 'response-item',
    itemType: 'message',
    payload: entry.payload as Record<string, unknown>,
    evidence: null,
  }] as never)
  const message = document.entries.find(item => item.kind === 'message' && item.role === 'user')
  if (!message || message.kind !== 'message') throw new Error('no decoded user message')
  return message.content
}

/** The report exactly as the renderer receives it. */
function recordedReport(name: string): RewindSessionAttachment[] {
  return toRewindSessionAttachments(rewindAttachments(codexUserContent(fixture(name).entry as Record<string, unknown>)))
}

/**
 * The three-image USER PROMPT the corpus really does contain (#1100 review).
 *
 * An earlier version of this file claimed no recorded multi-attachment user
 * prompt existed and built those cases by hand. It does exist: a Claude-shaped
 * message preserved under `_atp.source` inside a Codex rollout, because the
 * session was switched provider mid-task. The repo already asserts its three
 * images elsewhere (`imageAttachment.test.ts`).
 *
 * The real limitation is narrower and worth stating exactly: no recorded USER
 * prompt carries a filename, so the naming and truncation cases below are
 * still built from the schema — and labelled as such.
 */
function recordedThreeImagePrompt(): RewindSessionAttachment[] {
  const entry = fixture('atp-claude-image-inside-codex-rollout').entry as Record<string, unknown>
  const source = (entry._atp as Record<string, unknown>).source as Record<string, unknown>
  // Through the REAL classifier, the way `loadClaudeSnapshotAt` does it: a
  // hand-built record shape would be testing my idea of a Claude record.
  const document = decodeClaudeConversation([classifyClaudeRecord(source, 1)])
  const message = document.entries.find(item => item.kind === 'message' && item.role === 'user')
  if (!message || message.kind !== 'message') throw new Error('no decoded user message')
  return toRewindSessionAttachments(rewindAttachments(message.content))
}

describe('what a rewind could not bring back (#1075)', () => {
  const single = recordedReport('codex-user-attachment-no-detail')
  const several = recordedThreeImagePrompt()

  it('the recordings really carry what the cases below rely on', () => {
    expect(single.map(attachment => attachment.status)).toEqual(['restored'])
    // A recorded USER prompt with three images — the case an earlier version of
    // this file said the corpus did not have.
    expect(several).toHaveLength(3)
    expect(several.every(attachment => attachment.status === 'restored')).toBe(true)
    // And none of them is named, which is the real limitation.
    expect(several.every(attachment => attachment.name === null)).toBe(true)
  })

  it('says nothing when everything came back', () => {
    expect(describeRewindAttachmentLoss(single, { composerCarriesImages: true })).toBeNull()
    expect(describeRewindAttachmentLoss(several, { composerCarriesImages: true })).toBeNull()
  })

  it('reports a perfectly restored image the composer cannot carry', () => {
    // The Codex/OpenCode/Grok case, and the one the issue is really about: the
    // picker said `[Image prompt]`, the rewind worked, and the composer is
    // empty because the provider declares no image support.
    const message = describeRewindAttachmentLoss(single, { composerCarriesImages: false })

    expect(message).toContain('1 attachment')
    expect(message).toMatch(/cannot carry attachments/)
  })

  it('counts a recorded three-image prompt without inventing a plural noun', () => {
    // "they are an image" is what the first version said here, on this very
    // recording (#1100 review). One reason per attachment removes the
    // agreement problem instead of patching it.
    const message = describeRewindAttachmentLoss(several, { composerCarriesImages: false })

    expect(message).toContain('3 attachments')
    expect(message).not.toMatch(/they are an image/)
  })

  it('never tells a user their PDF was dropped for being a PDF when nothing could have carried it', () => {
    // The falsehood that made this a blocking review finding: `unsupported`
    // said "the composer carries images only" on providers whose composer
    // carries NOTHING — so the user converts the PDF to a PNG and watches that
    // get dropped too. Reachable: an OpenCode `{type:'file', mime:'application/pdf'}`
    // part decodes to a document, and OpenCode declares no image support.
    const message = describeRewindAttachmentLoss(
      [{ status: 'unsupported', mediaType: 'application/pdf', name: 'spec.pdf' }],
      { composerCarriesImages: false },
    )

    expect(message).toMatch(/cannot carry attachments/)
    expect(message).not.toMatch(/images only/)
  })

  it('does not contradict itself when one prompt mixed an image with a document', () => {
    // The same sentence used to assert both "it is an image and this provider
    // cannot carry images" AND "it is not an image, and the composer carries
    // images only".
    const message = describeRewindAttachmentLoss([
      { status: 'restored', mediaType: 'image/png', name: 'shot.png' },
      { status: 'unsupported', mediaType: 'application/pdf', name: 'spec.pdf' },
    ], { composerCarriesImages: false })

    expect(message).not.toMatch(/images only/)
    expect(message).toContain('shot.png')
    expect(message).toContain('spec.pdf')
  })

  it('attaches each reason to ITS OWN file, so nothing has to be paired by position', () => {
    // The names were listed in attachment order and the reasons in category
    // order, so a reader pairing them positionally paired them wrongly — and
    // this case needs no capability mismatch at all, just two Claude images
    // that failed differently.
    const message = describeRewindAttachmentLoss([
      { status: 'unavailable', reason: 'unreadable', mediaType: 'image/png', name: 'broken.png' },
      { status: 'unavailable', reason: 'external-reference', mediaType: 'image/png', name: 'design.png' },
    ], { composerCarriesImages: true })!

    expect(message).toMatch(/broken\.png \(the record could not be decoded\)/)
    expect(message).toMatch(/design\.png \(the transcript recorded a reference, not the file\)/)
    // The order of the phrases follows the ATTACHMENTS, so what a reader sees
    // first is what came first in their prompt.
    expect(message.indexOf('broken.png')).toBeLessThan(message.indexOf('design.png'))
  })

  it('says every distinct reason, not just the first', () => {
    const message = describeRewindAttachmentLoss([
      { status: 'unsupported', mediaType: 'application/pdf', name: 'spec.pdf' },
      { status: 'unavailable', reason: 'external-reference', mediaType: null, name: 'shot.png' },
    ], { composerCarriesImages: true })

    expect(message).toMatch(/images only/)
    expect(message).toMatch(/recorded a reference/)
    expect(message).toContain('2 attachments')
  })

  it('names at most two, and says how many it did not name', () => {
    // A toast listing eight filenames is a toast nobody reads. The tail is
    // counted rather than dropped, because a list that looks complete and is
    // not sends the reader looking for a name that was never printed — and it
    // must not be claimed when nothing is hidden.
    const four = describeRewindAttachmentLoss([
      { status: 'unsupported', mediaType: 'application/pdf', name: 'one.pdf' },
      { status: 'unsupported', mediaType: 'application/pdf', name: 'two.pdf' },
      { status: 'unsupported', mediaType: 'application/pdf', name: 'three.pdf' },
      { status: 'unsupported', mediaType: 'application/pdf', name: 'four.pdf' },
    ], { composerCarriesImages: true })!

    expect(four).toContain('one.pdf')
    expect(four).toContain('two.pdf')
    expect(four).toContain('and 2 more')
    expect(four).not.toContain('three.pdf')

    const two = describeRewindAttachmentLoss([
      { status: 'unsupported', mediaType: 'application/pdf', name: 'one.pdf' },
      { status: 'unsupported', mediaType: 'application/pdf', name: 'two.pdf' },
    ], { composerCarriesImages: true })!

    expect(two).toContain('two.pdf')
    expect(two).not.toContain('more')
  })

  it('says what happened, not just what was lost', () => {
    // The sentence's verb phrase is the whole message: "2 attachments:" and a
    // list of reasons is a fragment that never says the attachments are GONE.
    const message = describeRewindAttachmentLoss(
      [{ status: 'unavailable', reason: 'unreadable', mediaType: null, name: null }],
      { composerCarriesImages: true },
    )!

    expect(message).toContain('1 attachment did not come back')
  })

  it('distinguishes a reference from a record it could not read', () => {
    // Two different things to do about them: find the file, or report a
    // decoding bug. Saying both the same way loses that.
    const reference = describeRewindAttachmentLoss(
      [{ status: 'unavailable', reason: 'external-reference', mediaType: null, name: null }],
      { composerCarriesImages: false },
    )
    const unreadable = describeRewindAttachmentLoss(
      [{ status: 'unavailable', reason: 'unreadable', mediaType: null, name: null }],
      { composerCarriesImages: false },
    )

    expect(reference).toMatch(/recorded a reference/)
    expect(unreadable).toMatch(/could not be decoded/)
    expect(reference).not.toEqual(unreadable)
  })

  it('counts only what was actually lost', () => {
    // A mixed prompt on a provider that DOES carry images: the restored one is
    // in the composer, so saying "2 attachments did not come back" would send
    // the user looking for something that is right in front of them.
    const message = describeRewindAttachmentLoss([
      ...single,
      { status: 'unavailable', reason: 'external-reference', mediaType: null, name: 'shot.png' },
    ], { composerCarriesImages: true })

    expect(message).toContain('1 attachment')
    expect(message).toContain('shot.png')
  })
})
