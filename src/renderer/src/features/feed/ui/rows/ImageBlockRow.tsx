import { memo } from 'react'

import type { ContentBlock } from '@shared/types/transcript'

import { imageDataUrl } from '../../lib/helpers'
import { MarkerRow } from '../MarkerRow'

import { UserBand } from './primitives'

// Image content-block renderer. Handles both directions of the
// conversation: an inline image pasted by the user (`❯` marker +
// UserBand highlight) or an image emitted by an assistant tool call
// (`⏺` marker, no band). The image itself is rendered from a base64
// data: URL — the transcript wire format never carries remote URLs
// for inline images, only inline bytes. When the data is missing
// (malformed block), we render a small "image" placeholder pill
// instead of failing silently.
export const ImageBlockRow = memo(function ImageBlockRow({
  block,
  role,
}: {
  block: ContentBlock
  role: 'user' | 'assistant'
}) {
  const src = imageDataUrl(block)
  const mediaType =
    typeof (block as { source?: { media_type?: unknown } }).source?.media_type === 'string'
      ? (block as { source: { media_type: string } }).source.media_type
      : 'image'
  const alt = role === 'user' ? 'Pasted image' : 'Image'
  const row = (
    <MarkerRow marker={role === 'user' ? '❯' : '⏺'}>
      <div>
        {src ? (
          <img
            src={src}
            alt={alt}
            title={mediaType}
            className="max-h-[28rem] max-w-full rounded border border-border object-contain bg-surface"
          />
        ) : (
          <div className="text-muted text-[11px] uppercase tracking-wider">
            image
          </div>
        )}
      </div>
    </MarkerRow>
  )
  return role === 'user' ? <UserBand>{row}</UserBand> : row
})
