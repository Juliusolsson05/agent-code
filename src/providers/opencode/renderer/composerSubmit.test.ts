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
