import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { decodeCodexConversation, decodeOpencodeConversation } from 'agent-transcript-parser'
import type { ConversationContent } from 'agent-transcript-parser'

import { getHostTranscriptAdapter } from './transcriptEngine.js'
import { attachmentOnlyLabel, rewindAttachments } from './rewindAttachments.js'

// ---------------------------------------------------------------------------
// #929. Rewind's draft contract could not represent an attachment at all for
// Codex, OpenCode or Grok: `plainDraft` returned `promptImages: []`
// unconditionally, and `promptsFromSnapshot` drops a prompt whose text and
// images are both empty. So an IMAGE-ONLY prompt did not merely lose its
// image — the whole turn disappeared from the Rewind picker and could not be
// rewound to. A text+image prompt came back silently text-only.
//
// The Codex input below is REAL: `testing/fixtures/image-reads/` holds records
// captured verbatim from live sessions, with only the base64 payload swapped
// for a 1x1 PNG and the original length recorded (see its MANIFEST). That
// substitution is exactly right here — nothing under test decodes the bytes,
// it branches on envelope shape and declared MIME — and it is the reason
// these fixtures can exist in the repo at all.
// ---------------------------------------------------------------------------

const fixture = (name: string): Record<string, unknown> => JSON.parse(
  readFileSync(resolve(__dirname, `../../../testing/fixtures/image-reads/${name}.json`), 'utf8'),
) as Record<string, unknown>

/** The decoded content of the user message in a recorded Codex rollout entry.
 *  Classified the way `classifyCodexDocument` classifies it — a response-item
 *  message — so the decoder under test is the real one. */
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

const RECORDED_CODEX = fixture('codex-user-attachment-no-detail')

describe('a REAL recorded Codex attachment reaches the draft (#929)', () => {
  const content = codexUserContent(RECORDED_CODEX.entry as Record<string, unknown>)

  it('the recording really carries an image — otherwise everything below is vacuous', () => {
    expect(content.some(item => item.kind === 'image')).toBe(true)
    expect(content.some(item => item.kind === 'text')).toBe(true)
  })

  it('restores it, where the draft used to return an empty list', () => {
    const draft = getHostTranscriptAdapter('codex').draft(content)
    expect(draft.promptImages).toHaveLength(1)
    expect(draft.promptImages[0]!.mediaType).toBe('image/png')
    expect(draft.promptAttachments).toEqual([
      { status: 'restored', mediaType: 'image/png', data: expect.any(String), name: null },
    ])
    // The prose still comes through beside it.
    expect(draft.promptText).toContain('[Image #1]')
  })

  it('keeps an IMAGE-ONLY prompt in the picker instead of deleting the turn', () => {
    // Derived from the recording by dropping its text parts — the shape is
    // real, the absence of text is the case under test. This is the one that
    // made a turn unreachable: no text, no images, so the row was dropped.
    const imageOnly = content.filter(item => item.kind === 'image')
    const draft = getHostTranscriptAdapter('codex').draft(imageOnly)
    expect(draft.promptText).toBe('')
    expect(attachmentOnlyLabel(draft.promptAttachments)).toBe('[Image prompt]')
  })
})

describe('a reference is reported, never followed', () => {
  // The acceptance condition in #929: "without substituting changed
  // filesystem bytes". Re-reading a path recorded weeks ago would resend
  // whatever is on disk NOW under the belief that it is the original.
  it('says so when Codex recorded a path instead of the bytes', () => {
    const attachments = rewindAttachments([
      { kind: 'image', value: { type: 'input_image', image_url: '/Users/someone/screenshot.png' } },
    ] as never)
    expect(attachments).toEqual([
      { status: 'unavailable', reason: 'external-reference', mediaType: null, name: null },
    ])
  })

  it('says so when Claude recorded a url source', () => {
    const attachments = rewindAttachments([
      { kind: 'image', value: { source: { type: 'url', url: 'https://example.test/a.png', media_type: 'image/png' } } },
    ] as never)
    expect(attachments).toEqual([
      { status: 'unavailable', reason: 'external-reference', mediaType: 'image/png', name: null },
    ])
  })

  it('labels an unavailable-only prompt honestly rather than promising an image', () => {
    const one = rewindAttachments([
      { kind: 'image', value: { type: 'input_image', image_url: '/tmp/a.png' } },
    ] as never)
    expect(attachmentOnlyLabel(one)).toBe('[Attachment unavailable]')
    const two = rewindAttachments([
      { kind: 'image', value: { type: 'input_image', image_url: '/tmp/a.png' } },
      { kind: 'image', value: { type: 'input_image', image_url: '/tmp/b.png' } },
    ] as never)
    expect(attachmentOnlyLabel(two)).toBe('[2 attachments unavailable]')
  })

  it('reports a shape it cannot read rather than dropping it', () => {
    // An attachment this cannot decode is still an attachment the prompt had.
    // Silence is the failure mode this whole change is about.
    expect(rewindAttachments([{ kind: 'image', value: { type: 'input_image' } }] as never))
      .toEqual([{ status: 'unavailable', reason: 'unreadable', mediaType: null, name: null }])
    expect(rewindAttachments([{ kind: 'image', value: 'not an object' }] as never))
      .toEqual([{ status: 'unavailable', reason: 'unreadable', mediaType: null, name: null }])
  })

  it('refuses a data URL that is not base64', () => {
    // `data:text/plain,hello` is not bytes anyone attached, and handing it to
    // the composer as image data would produce something it cannot decode.
    expect(rewindAttachments([
      { kind: 'image', value: { type: 'input_image', image_url: 'data:text/plain,hello' } },
    ] as never)).toEqual([
      { status: 'unavailable', reason: 'external-reference', mediaType: null, name: null },
    ])
  })
})

describe('OpenCode file parts, through the real decoder', () => {
  // The export shape OpenCode really shipsimage and document parts in, taken
  // from the parser's own recorded projection fixtures.
  const exported = {
    info: { id: 'ses_1', directory: '/project', time: { created: 1, updated: 2 } },
    messages: [{
      info: { id: 'msg_1', role: 'user', sessionID: 'ses_1', time: { created: 1 } },
      parts: [
        { id: 'prt_0', type: 'text', text: 'look at this', sessionID: 'ses_1', messageID: 'msg_1' },
        { id: 'prt_1', type: 'file', mime: 'image/png', filename: 'clipboard', url: 'data:image/png;base64,AAAA', sessionID: 'ses_1', messageID: 'msg_1' },
        { id: 'prt_2', type: 'file', mime: 'application/pdf', filename: 'spec.pdf', url: 'data:application/pdf;base64,DDDD', sessionID: 'ses_1', messageID: 'msg_1' },
      ],
    }],
  }
  const content = (() => {
    const document = decodeOpencodeConversation(exported as never)
    const message = document.entries.find(item => item.kind === 'message' && item.role === 'user')
    if (!message || message.kind !== 'message') throw new Error('no decoded user message')
    return message.content
  })()

  it('restores an image and reports a document as unsupported', () => {
    // The PDF's bytes are right there, but the composer carries images only.
    // Calling it unsupported is what lets the picker say so, rather than
    // implying the prompt had nothing but a picture.
    const draft = getHostTranscriptAdapter('opencode').draft(content)
    expect(draft.promptText).toBe('look at this')
    expect(draft.promptImages).toEqual([{ mediaType: 'image/png', data: 'AAAA' }])
    expect(draft.promptAttachments).toEqual([
      { status: 'restored', mediaType: 'image/png', data: 'AAAA', name: 'clipboard' },
      { status: 'unsupported', mediaType: 'application/pdf', name: 'spec.pdf' },
    ])
  })

  it('trusts the declared mime over the data URL\'s own label', () => {
    // OpenCode routes the part on `mime`; the data URL's label is whatever
    // the writer put there.
    expect(rewindAttachments([
      { kind: 'document', value: { type: 'file', mime: 'application/pdf', url: 'data:image/png;base64,AAAA', filename: 'x' } },
    ] as never)).toEqual([{ status: 'unsupported', mediaType: 'application/pdf', name: 'x' }])
  })
})

describe('every provider answers the same question', () => {
  it('no adapter silently returns an empty attachment list any more', () => {
    // The asymmetry that caused this: only Claude looked at attachments, with
    // its own inline loop, while `plainDraft` — Codex, OpenCode and Grok —
    // returned [] unconditionally. A per-provider copy is how that comes back.
    const image: ConversationContent[] = [
      { kind: 'image', value: { source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } } },
    ] as never
    for (const provider of ['claude', 'codex', 'opencode', 'grok'] as const) {
      const draft = getHostTranscriptAdapter(provider).draft(image)
      expect(draft.promptAttachments, provider).toEqual([
        { status: 'restored', mediaType: 'image/png', data: 'AAAA', name: null },
      ])
      expect(draft.promptImages, provider).toEqual([{ mediaType: 'image/png', data: 'AAAA' }])
    }
  })
})
