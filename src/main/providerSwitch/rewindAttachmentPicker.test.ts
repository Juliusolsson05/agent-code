import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// #929, end to end through the picker. The draft contract is only half the
// bug: `promptsFromSnapshot` drops a prompt whose reconstructed text and
// images are both empty, so on Codex an image-only prompt did not just lose
// its image — the TURN disappeared from the Rewind picker and could not be
// rewound to at all.
//
// This runs the real pipeline: `listPrompts` reads a real rollout file off
// disk, classifies and decodes it with agent-transcript-parser, and builds
// every row through the same `draft()` the renderer prefills the composer
// from. Only the rollout LOOKUP is stubbed — that is a path on the user's
// disk and the one thing a test cannot supply.
// ---------------------------------------------------------------------------

const FIXTURE = resolve(__dirname, '../../../testing/fixtures/rewind-attachments/codex-image-prompts-2026-09-20.jsonl')

vi.mock('@main/providerSwitch/shared.js', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@main/providerSwitch/shared.js')
  return { ...actual, findCodexRolloutPathBySessionId: async () => FIXTURE }
})

const { getHostTranscriptAdapter } = await import('./transcriptEngine.js')
const codex = getHostTranscriptAdapter('codex')

/** The recorded turn's prose, joined the way `plainDraft` joins text parts. */
const RECORDED_TEXT = (JSON.parse(
  readFileSync(FIXTURE, 'utf8').split('\n')[3]!,
) as { payload: { content: Array<{ type: string; text?: string }> } })
  .payload.content.filter(part => part.type === 'input_text').map(part => part.text).join('\n')

async function rows(): Promise<string[]> {
  const prompts = await codex.listPrompts('/fixture/project', 'ignored')
  return prompts.map(prompt => prompt.text)
}

describe('a prompt that was only an attachment stays rewindable (#929)', () => {
  it('lists every user turn, including the ones with no text', async () => {
    expect(await rows()).toEqual([
      // The first prompt is absent by the engine's resumable-prefix rule,
      // which predates this change. Derived from the recording rather than
      // retyped, so editing the fixture cannot leave a stale expectation.
      RECORDED_TEXT,
      // Recorded image, no text. This row did not exist before: no text and
      // no images meant the turn was dropped and could not be rewound to.
      '[Image prompt]',
      // An attachment we will not follow. The row says so rather than
      // implying the image is coming back with the prompt.
      '[Attachment unavailable]',
    ])
  })

  it('the image-only turn really has an addressable prompt, not just a label', async () => {
    // A row the picker shows but cannot resolve would be worse than no row.
    const prompts = await codex.listPrompts('/fixture/project', 'ignored')
    const imageOnly = prompts.find(prompt => prompt.text === '[Image prompt]')
    expect(imageOnly?.address).toMatchObject({ provider: 'codex' })
    expect(imageOnly?.address.line).toBeGreaterThan(0)
    expect(imageOnly?.timestamp).toBe('2026-09-20T09:02:00.000Z')
  })

  it('carries the recorded image into the composer prefill', async () => {
    const document = await codex.readAt!(FIXTURE)
    const entry = document.entries.find(item => (
      item.kind === 'message' && item.role === 'user'
      && item.content.length === 1 && item.content[0]!.kind === 'image'
    ))
    if (!entry || entry.kind !== 'message') throw new Error('no image-only user turn')
    const draft = codex.draft(entry.content)
    expect(draft.promptImages).toHaveLength(1)
    expect(draft.promptImages[0]!.mediaType).toBe('image/png')
    expect(draft.promptAttachments[0]!.status).toBe('restored')
  })

  it('does not invent bytes for a reference', async () => {
    const document = await codex.readAt!(FIXTURE)
    const entry = document.entries.find(item => (
      item.kind === 'message' && item.role === 'user'
      && item.content.some(part => part.kind === 'image'
        && typeof (part.value as { image_url?: unknown }).image_url === 'string'
        && !String((part.value as { image_url?: unknown }).image_url).startsWith('data:'))
    ))
    if (!entry || entry.kind !== 'message') throw new Error('no reference-only user turn')
    const draft = codex.draft(entry.content)
    expect(draft.promptImages).toEqual([])
    expect(draft.promptAttachments).toEqual([
      { status: 'unavailable', reason: 'external-reference', mediaType: null, name: null },
    ])
  })
})

describe('the loss report crosses IPC without the bytes', () => {
  // #1073 review, finding 3. `rewindSession` used to SPREAD the draft into its
  // result, and a spread bypasses excess-property checking — so
  // `promptAttachments` shipped undeclared, structured-cloned verbatim. The
  // corpus mean attachment is 326k base64 characters and the largest real
  // prompt is 2.8 MB across twelve images, every one of which crossed twice:
  // once in `promptImages`, once again inside `promptAttachments`.
  it('reports each attachment\'s fate and carries no base64 twice', async () => {
    const { toRewindSessionAttachments } = await import('./rewindSession.js')
    const report = toRewindSessionAttachments([
      { status: 'restored', mediaType: 'image/png', data: 'AAAA', name: 'clipboard' },
      { status: 'unavailable', reason: 'external-reference', mediaType: null, name: null },
      { status: 'unsupported', mediaType: 'application/pdf', name: 'spec.pdf' },
    ])
    expect(report).toEqual([
      { status: 'restored', mediaType: 'image/png', name: 'clipboard' },
      { status: 'unavailable', reason: 'external-reference', mediaType: null, name: null },
      { status: 'unsupported', mediaType: 'application/pdf', name: 'spec.pdf' },
    ])
    // The bytes are gone from the report — they already cross in promptImages.
    expect(JSON.stringify(report)).not.toContain('AAAA')
    expect(report.every(entry => !('data' in entry))).toBe(true)
  })
})
