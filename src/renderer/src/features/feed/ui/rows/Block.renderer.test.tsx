import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ContentBlock } from '@shared/types/transcript'
import { RenderShapeCaptureContext } from '@renderer/features/feed/evidence/RenderShapeCaptureContext'

const { observeRenderShape } = vi.hoisted(() => ({
  observeRenderShape: vi.fn(),
}))

vi.mock('@renderer/features/feed/evidence/observer', () => ({
  observeRenderShape,
}))

import { Block } from './Block'

function renderCapturedBlock(block: ContentBlock): void {
  render(
    <RenderShapeCaptureContext.Provider value={{ sessionId: 'session-1', provider: 'claude' }}>
      <Block block={block} role="assistant" />
    </RenderShapeCaptureContext.Provider>,
  )
}

describe('Block content-envelope evidence', () => {
  beforeEach(() => observeRenderShape.mockClear())

  it('keeps exact native content cheap but sights known-label structural drift', () => {
    renderCapturedBlock({ type: 'text', text: 'ordinary answer' })
    expect(screen.getByText('ordinary answer')).toBeInTheDocument()
    expect(observeRenderShape).not.toHaveBeenCalled()

    renderCapturedBlock({
      type: 'text',
      text: 'answer with a future carrier',
      citations: [{ source: 'future' }],
    } as ContentBlock)
    expect(screen.getByText('answer with a future carrier')).toBeInTheDocument()
    expect(observeRenderShape).toHaveBeenCalledTimes(1)
    expect(observeRenderShape).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-1',
      provider: 'claude',
      plane: 'transcript-entry',
      lifecycle: 'durable',
      eventType: 'text',
      outcome: {
        kind: 'unknown',
        fallbackRenderId: 'shared.content-block-envelope-drift',
      },
    }))
  })
})
