import { memo, useState } from 'react'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import type { AgentProviderKind } from '@shared/types/providerKind'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { StatusBadge } from '@renderer/features/feed/ui/kit/StatusBadge'
import { OutputWell } from '@renderer/features/feed/ui/kit/OutputWell'
import { toolResultText } from '@renderer/features/feed/lib/helpers'
import type { SemanticLiveTurn } from '@renderer/session-runtime/state'

import type { ImageGenArtifact } from './types'

type SemanticLiveBlock = SemanticLiveTurn['blocks'][number]
type SemanticToolCallSnapshot = SemanticLiveTurn['lookups']['toolCallsById'][string]

const INLINE_GENERATED_IMAGE_MAX_CHARS = 4 * 1024 * 1024

// ImageGenCard — Codex image_generation_call (live) and the rollout-
// synthesized `image_generation` committed twin. The result may be a
// provider-side handle or a bounded base64 raster, so this card owns both the
// lifecycle surface and an optional lazy inline preview.

export function imageGenFromCommitted(
  tu: ToolUseBlock,
  result: ToolResultBlock | null,
  provider: AgentProviderKind,
): ImageGenArtifact {
  const input = (tu.input ?? {}) as Record<string, unknown>
  const genStatus = typeof input.status === 'string' ? input.status : null
  return {
    family: 'image-gen',
    id: `img:${tu.id}`,
    provider,
    status:
      result?.is_error === true
        ? 'error'
        : genStatus === 'completed' || result
          ? 'complete'
          : 'running',
    plane: 'committed',
    toolUseId: tu.id,
    startedAt: null,
    endedAt: null,
    genStatus,
    revisedPrompt:
      typeof input.revisedPrompt === 'string' ? input.revisedPrompt : null,
    result: result ? toolResultText(result).trim() || null : null,
  }
}

export function imageGenFromLive(
  block: SemanticLiveBlock,
  _toolState: SemanticToolCallSnapshot | null,
  provider: AgentProviderKind,
): ImageGenArtifact {
  const id = block.toolUseId ?? block.callId ?? block.itemId ?? `live:${block.blockIndex}`
  const img = block.imageGeneration
  const genStatus = img?.status ?? block.status ?? null
  return {
    family: 'image-gen',
    id: `img:${id}`,
    provider,
    status: genStatus === 'completed' ? 'complete' : 'running',
    plane: 'live',
    toolUseId: block.toolUseId ?? block.callId ?? null,
    startedAt: null,
    endedAt: block.resultAt ?? null,
    genStatus,
    revisedPrompt: img?.revisedPrompt ?? null,
    result: img?.result ?? null,
  }
}

export const ImageGenCard = memo(function ImageGenCard({ vm }: { vm: ImageGenArtifact }) {
  const [expanded, setExpanded] = useState(false)
  const imageSrc = generatedImageSrc(vm.result)

  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-col gap-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] leading-[1.65]">
          <span className="text-accent font-semibold">🖼 Image generation</span>
          {vm.genStatus && vm.status !== 'complete' ? (
            <span className="text-muted text-[11px] uppercase tracking-wider">
              {vm.genStatus.replace(/_/g, ' ')}
            </span>
          ) : null}
          <StatusBadge status={vm.status} />
        </div>
        {vm.revisedPrompt ? (
          <MarkerRow marker="⎿" tone="muted">
            <div className="text-ink-dim text-[12px] leading-[1.55] italic">
              {vm.revisedPrompt}
            </div>
          </MarkerRow>
        ) : null}
        {imageSrc ? (
          <MarkerRow marker="⎿" tone="muted">
            <button
              type="button"
              onClick={() => setExpanded(value => !value)}
              aria-expanded={expanded}
              className="block max-w-full cursor-zoom-in focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent rounded"
              title={expanded ? 'Collapse generated image' : 'Expand generated image'}
            >
              <img
                src={imageSrc}
                alt={vm.revisedPrompt ? `Generated image: ${vm.revisedPrompt}` : 'Generated image'}
                loading="lazy"
                decoding="async"
                className={`${expanded ? 'max-h-[80vh]' : 'max-h-[28rem]'} max-w-full rounded border border-border object-contain bg-surface`}
              />
            </button>
          </MarkerRow>
        ) : vm.result ? (
          <OutputWell text={vm.result} isError={vm.status === 'error'} ansi />
        ) : null}
      </div>
    </MarkerRow>
  )
})

function generatedImageSrc(result: string | null): string | null {
  if (!result) return null
  // Data URL construction duplicates encoded bytes and asks Chromium to decode
  // them. Keep the same bounded policy as typed MCP images; oversized results
  // remain available through OutputWell's exact-source disclosure instead of
  // becoming an eager renderer allocation.
  if (result.length > INLINE_GENERATED_IMAGE_MAX_CHARS) return null
  if (/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-zA-Z0-9+/=\r\n]+$/.test(result)) {
    return result
  }
  // Responses image_generation_call documents `result` as base64 PNG. Require
  // a meaningful length and the strict alphabet so an arbitrary provider string
  // cannot become an active data URL. SVG is intentionally unsupported.
  if (result.length >= 64 && /^[a-zA-Z0-9+/=\r\n]+$/.test(result)) {
    return `data:image/png;base64,${result}`
  }
  return null
}
