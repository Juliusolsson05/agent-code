import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { decodeCodexConversation } from 'agent-transcript-parser'
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

describe('what a rewind could not bring back (#1075)', () => {
  const single = recordedReport('codex-user-attachment-no-detail')
  // The corpus has exactly one recorded multi-attachment case and it is an
  // exec tool RESULT, not a user prompt — a rewind target is a user prompt, so
  // it cannot stand in for one. The several-attachment cases below are built
  // from the report SCHEMA and labelled as such, rather than pretending a
  // recording says something it does not.
  const several: RewindSessionAttachment[] = [
    ...single,
    { status: 'restored', mediaType: 'image/png', name: 'second.png' },
    { status: 'restored', mediaType: 'image/png', name: 'third.png' },
  ]

  it('the recording really carries a restorable attachment — otherwise everything below is vacuous', () => {
    expect(single.map(attachment => attachment.status)).toEqual(['restored'])
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
    expect(message).toMatch(/cannot carry images/)
  })

  it('counts them, and names only the first two, when a prompt carried several', () => {
    const message = describeRewindAttachmentLoss(several, { composerCarriesImages: false })

    expect(message).toContain(`${several.length} attachments`)
    // A toast that lists eight filenames is a toast nobody reads; two plus a
    // count is enough to recognise WHICH one is missing. The ellipsis says
    // the list is partial — without it, "3 attachments (a, b)" reads as a
    // complete list and sends the reader looking for a third name that was
    // never printed. (The recorded attachment has no name of its own, which
    // is why only two appear here.)
    expect(message).toContain('second.png')
    expect(message).toContain('third.png')
    expect(message).toContain('…')
  })

  it('shows at most two names however many are lost', () => {
    const message = describeRewindAttachmentLoss([
      { status: 'unsupported', mediaType: 'application/pdf', name: 'one.pdf' },
      { status: 'unsupported', mediaType: 'application/pdf', name: 'two.pdf' },
      { status: 'unsupported', mediaType: 'application/pdf', name: 'three.pdf' },
      { status: 'unsupported', mediaType: 'application/pdf', name: 'four.pdf' },
    ], { composerCarriesImages: true })

    expect(message).toContain('4 attachments (one.pdf, two.pdf, …)')
    expect(message).not.toContain('three.pdf')
  })

  it.each([
    {
      name: 'a reference the transcript never stored',
      attachment: { status: 'unavailable', reason: 'external-reference', mediaType: null, name: 'shot.png' },
      expected: /recorded a reference rather than the file/,
    },
    {
      name: 'a record this could not decode',
      attachment: { status: 'unavailable', reason: 'unreadable', mediaType: null, name: null },
      expected: /could not be decoded/,
    },
    {
      name: 'a document the composer has no room for',
      attachment: { status: 'unsupported', mediaType: 'application/pdf', name: 'spec.pdf' },
      expected: /not an image/,
    },
    {
      // The IPC shape flattens the union, so `reason` can be absent where
      // main's own type requires it. "Could not be read" is the honest default.
      name: 'an unavailable attachment with no reason at all',
      attachment: { status: 'unavailable', mediaType: null, name: null },
      expected: /could not be decoded/,
    },
  ] as Array<{ name: string; attachment: RewindSessionAttachment; expected: RegExp }>)('explains $name', ({ attachment, expected }) => {
    const message = describeRewindAttachmentLoss([attachment], { composerCarriesImages: true })
    expect(message).toMatch(expected)
    // Named files are named, because "which one?" is the question a person has.
    if (attachment.name) expect(message).toContain(attachment.name)
  })

  it('says BOTH reasons when one prompt lost attachments two different ways', () => {
    // Picking one reason would describe half the loss and leave the user
    // looking for a file that is missing for a different reason entirely.
    const message = describeRewindAttachmentLoss([
      { status: 'unsupported', mediaType: 'application/pdf', name: 'spec.pdf' },
      { status: 'unavailable', reason: 'external-reference', mediaType: null, name: 'shot.png' },
    ], { composerCarriesImages: true })

    expect(message).toMatch(/not an image/)
    expect(message).toMatch(/recorded a reference/)
    expect(message).toContain('2 attachments')
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
