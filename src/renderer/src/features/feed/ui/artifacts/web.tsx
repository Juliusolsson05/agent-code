import { memo } from 'react'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import type { AgentProviderKind } from '@shared/types/providerKind'
import { isHttpUrl } from '@providers/shared/renderer/rows/jsonToolPresentation'

import { toolResultText } from '@renderer/features/feed/lib/helpers'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { ExpandSection } from '@renderer/features/feed/ui/kit/ExpandSection'
import { OutputWell } from '@renderer/features/feed/ui/kit/OutputWell'
import { StatusBadge } from '@renderer/features/feed/ui/kit/StatusBadge'
import type { SemanticLiveTurn } from '@renderer/session-runtime/state'

import type { ArtifactStatus, WebArtifact } from './types'

type SemanticLiveBlock = SemanticLiveTurn['blocks'][number]
type SemanticToolCallSnapshot = SemanticLiveTurn['lookups']['toolCallsById'][string]

// WebCard — the ONE web surface (spec §6): Claude WebSearch/WebFetch,
// Codex web_search_call (live) and its rollout-synthesized `web_search`
// committed twin, plus tool_search. This kills audit gap #3's ugliest
// case: Codex web searches had a nice live chip (🌐 Search: …) and an
// unrecognizable generic committed row — same action, two looks.
//
// Links open through a plain target=_blank anchor gated by isHttpUrl —
// the same pattern JsonToolRow's ParamValue used (length-capped, http(s)
// only), so no new navigation surface is introduced.

const KIND_ICON: Record<WebArtifact['kind'], string> = {
  search: '🌐',
  fetch: '🌐',
  open_page: '🌐',
  find_in_page: '🔎',
}

const KIND_LABEL: Record<WebArtifact['kind'], string> = {
  search: 'Search',
  fetch: 'Fetch',
  open_page: 'Open',
  find_in_page: 'Find in page',
}

function kindFromString(kind: string | null, toolName: string): WebArtifact['kind'] {
  if (kind === 'open_page' || kind === 'find_in_page' || kind === 'search') return kind
  if (toolName === 'WebFetch') return 'fetch'
  return 'search'
}

export function webFromCommitted(
  tu: ToolUseBlock,
  result: ToolResultBlock | null,
  provider: AgentProviderKind,
): WebArtifact {
  const input = (tu.input ?? {}) as Record<string, unknown>
  return {
    family: 'web',
    id: `web:${tu.id}`,
    provider,
    status: !result ? 'running' : result.is_error === true ? 'error' : 'complete',
    plane: 'committed',
    toolUseId: tu.id,
    startedAt: null,
    endedAt: null,
    kind: kindFromString(
      typeof input.kind === 'string' ? input.kind : null,
      tu.name,
    ),
    query: typeof input.query === 'string' ? input.query : null,
    queries: Array.isArray(input.queries)
      ? input.queries.filter((q): q is string => typeof q === 'string')
      : [],
    url: typeof input.url === 'string' ? input.url : null,
    pattern: typeof input.pattern === 'string' ? input.pattern : null,
    resultText: result ? toolResultText(result).replace(/\s+$/, '') || null : null,
  }
}

export function webFromLive(
  block: SemanticLiveBlock,
  toolState: SemanticToolCallSnapshot | null,
  provider: AgentProviderKind,
): WebArtifact {
  const id = block.toolUseId ?? block.callId ?? block.itemId ?? `live:${block.blockIndex}`
  const action = block.webSearchAction
  const hasResult = block.resultAt != null || block.resultContent != null
  const status: ArtifactStatus =
    toolState?.status === 'error' || block.resultIsError === true
      ? 'error'
      : hasResult || block.status === 'completed'
        ? 'complete'
        : 'running'
  return {
    family: 'web',
    id: `web:${id}`,
    provider,
    status,
    plane: 'live',
    toolUseId: block.toolUseId ?? block.callId ?? null,
    startedAt: null,
    endedAt: block.resultAt ?? null,
    kind: kindFromString(action?.kind ?? null, block.toolName ?? ''),
    query: action?.query ?? null,
    queries: action?.queries ?? [],
    url: action?.url ?? null,
    pattern: action?.pattern ?? null,
    resultText: toolState?.resultContent ?? block.resultContent ?? null,
  }
}

export const WebCard = memo(function WebCard({
  vm,
  toolLabel,
}: {
  vm: WebArtifact
  /** 'Tool search' for tool_search rows; default derives from kind. */
  toolLabel?: string
}) {
  const label = toolLabel ?? KIND_LABEL[vm.kind]
  const subject = vm.query ?? (vm.queries.length > 0 ? vm.queries.join(', ') : null)
  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-col gap-0.5">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] leading-[1.65]">
          <span className="text-accent font-semibold">
            {KIND_ICON[vm.kind]} {label}
          </span>
          {subject ? <span className="text-ink break-words">{subject}</span> : null}
          {vm.pattern ? (
            <span className="font-code text-[12px] text-ink break-all">"{vm.pattern}"</span>
          ) : null}
          {vm.url ? (
            isHttpUrl(vm.url) ? (
              <a
                href={vm.url}
                target="_blank"
                rel="noreferrer"
                className="text-accent underline break-all text-[12px]"
              >
                {vm.url}
              </a>
            ) : (
              <span className="text-ink-dim break-all text-[12px]">{vm.url}</span>
            )
          ) : null}
          <StatusBadge status={vm.status} />
        </div>
        {vm.resultText ? (
          <MarkerRow marker="⎿" tone="muted">
            <ExpandSection summary="result">
              <OutputWell text={vm.resultText} isError={vm.status === 'error'} ansi />
            </ExpandSection>
          </MarkerRow>
        ) : null}
      </div>
    </MarkerRow>
  )
})
