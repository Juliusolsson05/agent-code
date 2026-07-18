import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ImageBlockRow } from './ImageBlockRow'

describe('ImageBlockRow', () => {
  it('does not duplicate base64 bytes into an image URL until the preview opens', () => {
    render(
      <ImageBlockRow
        role="assistant"
        block={{
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'YWJj' },
        }}
      />,
    )

    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    fireEvent.click(screen.getByText(/Image · image\/png/))
    expect(screen.getByRole('img')).toHaveAttribute('src', 'data:image/png;base64,YWJj')
  })

  it('declines active image formats while keeping a visible diagnostic', () => {
    render(
      <ImageBlockRow
        role="user"
        block={{
          type: 'image',
          source: { type: 'base64', media_type: 'image/svg+xml', data: 'PHN2Zz4=' },
        }}
      />,
    )

    fireEvent.click(screen.getByText(/Pasted image · image\/svg\+xml/))
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(screen.getByText(/preview unavailable/)).toBeInTheDocument()
  })

  it('keeps an unsupported image source schema visible through a lazy bounded disclosure', () => {
    render(
      <ImageBlockRow
        role="assistant"
        block={{
          type: 'image',
          source: { type: 'url', url: 'https://example.test/new-image-shape.png' },
        } as never}
      />,
    )

    expect(screen.queryByText(/new-image-shape\.png/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('View unsupported image source'))
    expect(screen.getByText(/new-image-shape\.png/)).toBeInTheDocument()
  })
})
