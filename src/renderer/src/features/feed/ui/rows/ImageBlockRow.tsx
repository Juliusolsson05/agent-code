import { memo } from 'react'

import type { ContentBlock } from '@shared/types/transcript'
import { asRecord } from '@shared/lib/asRecord'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { parseBase64MediaPreview } from '@providers/shared/renderer/protocols/media/base64'
import { Base64MediaView } from '@providers/shared/renderer/protocols/media/Base64MediaView'

import { UserBand } from '@renderer/features/feed/ui/rows/primitives'

// Provider-neutral image content-block renderer. The providers own the step
// that maps their wire image into this transcript block; this leaf owns only
// safe, bounded media presentation shared by user attachments and generated
// assistant images.
export const ImageBlockRow = memo(function ImageBlockRow({
  block,
  role,
}: {
  block: ContentBlock
  role: 'user' | 'assistant'
}) {
  const source = asRecord(asRecord(block)?.source)
  const media = parseBase64MediaPreview(
    'image',
    source?.media_type ?? source?.mimeType,
    source?.data,
  )
  const mediaType = media?.mimeType ?? (
    typeof source?.media_type === 'string'
      ? source.media_type
      : typeof source?.mimeType === 'string' ? source.mimeType : 'image'
  )
  const alt = role === 'user' ? 'Pasted image' : 'Image'
  const row = (
    <MarkerRow marker={role === 'user' ? '❯' : '⏺'}>
      <Base64MediaView
        model={media}
        label={`${alt} · ${mediaType}`}
        alt={alt}
      />
    </MarkerRow>
  )
  return role === 'user' ? <UserBand>{row}</UserBand> : row
})
