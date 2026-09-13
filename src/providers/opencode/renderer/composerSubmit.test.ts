import { describe, expect, it, vi } from 'vitest'

import type { ComposerSubmitIo } from '@providers/registry.renderer.capabilities'
import { opencodeComposerSubmit } from './composerSubmit.js'

describe('opencodeComposerSubmit', () => {
  it('preserves retry-unsafe delivery metadata on the thrown error', async () => {
    const delivery = {
      ok: false as const,
      stage: 'after-enter' as const,
      code: 'transport-failed' as const,
      message: 'request outcome unknown',
      retrySafe: false,
      disposition: 'do-not-retry' as const,
      promptWritten: true,
      enterWritten: true,
    }
    const io: ComposerSubmitIo = {
      sessionId: 's1',
      input: 'hello',
      draftImages: [],
      send: vi.fn(),
      deliverPrompt: vi.fn(async () => delivery),
      pasteId: 'paste-1',
      getScreen: () => undefined,
    }

    await expect(opencodeComposerSubmit(io)).rejects.toMatchObject({
      promptDeliveryResult: delivery,
    })
  })
})

describe('opencodeComposerSubmit acceptance', () => {
  it('returns the acceptance so the composer can tell a queued prompt from a started turn', async () => {
    // #889: the composer needs the acceptance kind to settle its optimistic
    // `submitting` phase when the provider queued the prompt instead of
    // starting a turn. Swallowing the result here would hide that signal.
    const acceptance = { kind: 'queue' as const, acceptedAt: 1_000 }
    const io: ComposerSubmitIo = {
      sessionId: 's1',
      input: 'hello',
      draftImages: [],
      send: vi.fn(),
      deliverPrompt: vi.fn(async () => ({ ok: true as const, acceptance })),
      pasteId: 'paste-1',
      getScreen: () => undefined,
    }

    await expect(opencodeComposerSubmit(io)).resolves.toEqual(acceptance)
  })
})
