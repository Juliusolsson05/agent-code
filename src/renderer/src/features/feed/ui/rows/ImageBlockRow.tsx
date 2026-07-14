import { memo, useEffect, useState } from 'react'

import type { ContentBlock } from '@shared/types/transcript'
import { asRecord } from '@shared/lib/asRecord'

import { imageDataUrl } from '@renderer/features/feed/lib/helpers'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'

import { UserBand } from '@renderer/features/feed/ui/rows/primitives'

// Image content-block renderer. Handles both directions of the
// conversation: an inline image pasted by the user (`❯` marker +
// UserBand highlight) or an image emitted by an assistant tool call
// (`⏺` marker, no band).
//
// Sources: base64 inline bytes (the common case — CC-pasted
// screenshots) AND the spec's `url` shape (previously dropped to a
// bare "image" placeholder — audit dropped-shape #4; http(s) only, so
// a malformed source can't smuggle an arbitrary scheme into <img>).
// Click-to-zoom: a dependency-free fixed-overlay lightbox — feed
// images are capped at 28rem, which makes real screenshots unreadable
// without it. ESC or click closes.

function imageSrc(block: ContentBlock): string | null {
  const inline = imageDataUrl(block)
  if (inline) return inline
  const source = asRecord(asRecord(block)?.source)
  if (source?.type === 'url' && typeof source.url === 'string' && /^https?:\/\//.test(source.url)) {
    return source.url
  }
  return null
}

function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 cursor-zoom-out"
      onClick={onClose}
    >
      <img src={src} alt={alt} className="max-h-[92vh] max-w-[92vw] object-contain" />
    </div>
  )
}

export const ImageBlockRow = memo(function ImageBlockRow({
  block,
  role,
}: {
  block: ContentBlock
  role: 'user' | 'assistant'
}) {
  const [zoomed, setZoomed] = useState(false)
  const src = imageSrc(block)
  const source = (block as { source?: { media_type?: unknown } }).source
  const mediaType =
    typeof source?.media_type === 'string'
      ? source.media_type
      : 'image'
  const alt = role === 'user' ? 'Pasted image' : 'Image'
  const row = (
    <MarkerRow marker={role === 'user' ? '❯' : '⏺'}>
      <div>
        {src ? (
          <>
            <img
              src={src}
              alt={alt}
              title={`${mediaType} (click to zoom)`}
              className="max-h-[28rem] max-w-full rounded border border-border object-contain bg-surface cursor-zoom-in"
              onClick={() => setZoomed(true)}
            />
            {zoomed ? <Lightbox src={src} alt={alt} onClose={() => setZoomed(false)} /> : null}
          </>
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
