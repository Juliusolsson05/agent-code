import { describe, expect, it } from 'vitest'

import {
  fromCodexImageGenerationUse,
  fromCodexSemanticImageGeneration,
} from './imageGeneration'

describe('Codex image generation adapter', () => {
  it('admits the normalized committed operation', () => {
    expect(fromCodexImageGenerationUse({
      type: 'tool_use',
      id: 'image-1',
      name: 'image_generation',
      input: { status: 'completed', revisedPrompt: 'A lighthouse' },
    })).toEqual({ status: 'completed', revisedPrompt: 'A lighthouse', result: null })
  })

  it('admits typed semantic evidence and declines malformed status', () => {
    expect(fromCodexSemanticImageGeneration({
      blockIndex: 1,
      kind: 'image_generation_call',
      imageGeneration: { status: 'completed', revisedPrompt: 'A lighthouse', result: 'YWJj' },
    })).toEqual({ status: 'completed', revisedPrompt: 'A lighthouse', result: 'YWJj' })

    expect(fromCodexSemanticImageGeneration({
      blockIndex: 1,
      kind: 'image_generation_call',
      imageGeneration: { status: '', result: '' },
    })).toBeNull()
  })
})
