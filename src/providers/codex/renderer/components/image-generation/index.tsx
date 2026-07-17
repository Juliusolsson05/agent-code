import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { boundedTextPage } from '@renderer/lib/text/boundedText'
import { Base64MediaView } from '@providers/shared/renderer/protocols/media/Base64MediaView'
import { parseBase64MediaPreview } from '@providers/shared/renderer/protocols/media/base64'

import type { CodexImageGenerationModel } from '@providers/codex/renderer/adapters/imageGeneration'

function promptPreview(prompt: string): string {
  const page = boundedTextPage(prompt, 0, 800, 6)
  return page.hasNext ? `${page.text}…` : page.text
}

export function CodexImageGenerationRow({
  model,
}: {
  model: CodexImageGenerationModel
}) {
  const media = model.result
    ? parseBase64MediaPreview('image', 'image/png', model.result)
    : null
  return (
    <MarkerRow marker="⏺">
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-[1.65]">
          <span className="font-semibold text-accent">🖼 Image generation</span>
          <span className="text-[11px] uppercase tracking-wider text-muted">
            {model.status.replace(/_/g, ' ')}
          </span>
        </div>
        {model.revisedPrompt ? (
          <div className="text-[12px] italic leading-[1.55] text-ink-dim">
            {promptPreview(model.revisedPrompt)}
          </div>
        ) : null}
        {model.result ? (
          <Base64MediaView
            model={media}
            label="Generated image · image/png"
            alt="Generated image"
          />
        ) : null}
      </div>
    </MarkerRow>
  )
}
