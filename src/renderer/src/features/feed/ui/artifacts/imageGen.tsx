import { memo } from 'react'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import type { AgentProviderKind } from '@shared/types/providerKind'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { StatusBadge } from '@renderer/features/feed/ui/kit/StatusBadge'
import type { SemanticLiveTurn } from '@renderer/session-runtime/state'

import type { ImageGenArtifact } from './types'

type SemanticLiveBlock = SemanticLiveTurn['blocks'][number]
type SemanticToolCallSnapshot = SemanticLiveTurn['lookups']['toolCallsById'][string]

// ImageGenCard — Codex image_generation_call (live) and the rollout-
// synthesized `image_generation` committed twin. The result payload is
// a provider-side handle (not inline image bytes), so the card is a
// status surface: label + revised prompt + badge. If Codex ever
// surfaces inline image data here, route it through ImageBlockRow.

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
    result: null,
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
      </div>
    </MarkerRow>
  )
})
