import { useState } from 'react'

import {
  base64MediaDataUrl,
  type Base64MediaPreview,
} from './base64'

export function Base64MediaView({
  model,
  label,
  alt,
}: {
  model: Base64MediaPreview | null
  label: string
  alt: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="min-w-0 text-[12px] text-ink-dim"
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer select-none break-all">
        {label}
        {model ? ` · ${model.estimatedBytes.toLocaleString()} bytes` : ''}
      </summary>
      {/* WHY the media element is state-gated in addition to using <details>:
          React mounts closed details children. A data URL duplicates the
          entire encoded payload into a DOM attribute, so eager mounting turns
          a replay with many images/audio results into avoidable memory growth. */}
      {open ? (
        <div className="mt-2">
          {model?.kind === 'image' ? (
            <img
              src={base64MediaDataUrl(model)}
              alt={alt}
              title={model.mimeType}
              className="max-h-[28rem] max-w-full rounded border border-border object-contain bg-surface"
            />
          ) : model?.kind === 'audio' ? (
            <audio
              controls
              preload="none"
              src={base64MediaDataUrl(model)}
              className="max-w-full"
            >
              {alt}
            </audio>
          ) : (
            <div className="text-muted text-[11px]">
              Media preview unavailable, unsupported, or above the 8 MiB preview budget.
            </div>
          )}
        </div>
      ) : null}
    </details>
  )
}
