import { memo, useContext } from 'react'

import { normalizeCodeLanguage } from '@shared/code/language'
import { formatToolFilePath } from '@shared/paths/displayPath'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import type { AgentProviderKind } from '@shared/types/providerKind'

import { CodeRenderContext } from '@renderer/features/feed/context'
import { toolResultText } from '@renderer/features/feed/lib/helpers'
import { extractStreamingWriteInput } from '@renderer/features/feed/lib/streamingWriteInput'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { ExpandSection } from '@renderer/features/feed/ui/kit/ExpandSection'
import { OutputWell } from '@renderer/features/feed/ui/kit/OutputWell'
import { StatusBadge } from '@renderer/features/feed/ui/kit/StatusBadge'
import { StreamingCodeBlock } from '@renderer/features/feed/ui/kit/StreamingCodeBlock'
import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import type { SemanticLiveTurn } from '@renderer/session-runtime/state'

import type { ArtifactStatus, FileWriteArtifact } from './types'

type SemanticLiveBlock = SemanticLiveTurn['blocks'][number]
type SemanticToolCallSnapshot = SemanticLiveTurn['lookups']['toolCallsById'][string]

// FileWriteCard — the ONE file-write surface (spec §6), and the payoff
// of the streaming-ambition decision: the live Write preview is now
// HIGHLIGHTED line-by-line (the old preview was highlight={false}
// because whole-string hljs per delta was O(bytes²); sealed-line
// caching makes highlight affordable). Committed renders the same
// StreamingCodeBlock — already-complete code seals in one pass and
// produces identical DOM, so the commit boundary is invisible except
// the badge flip and the line counter settling.
//
// Large committed files additionally offer "open in Monaco" behind a
// first-open ExpandSection (desktop affordance; the phone host simply
// never expands it — Monaco stays lazy).

const MONACO_OFFER_LINES = 80

function countLines(content: string): number {
  if (!content) return 0
  const normalized = content.endsWith('\n') ? content.slice(0, -1) : content
  return normalized === '' ? 0 : normalized.split('\n').length
}

export function fileWriteFromCommitted(
  tu: ToolUseBlock,
  result: ToolResultBlock | null,
  provider: AgentProviderKind,
): FileWriteArtifact & { resultError: string | null } {
  const input = (tu.input ?? {}) as Record<string, unknown>
  const filePath = typeof input.file_path === 'string' ? input.file_path : null
  const content = typeof input.content === 'string' ? input.content : ''
  const isError = result?.is_error === true
  const status: ArtifactStatus = !result ? 'running' : isError ? 'error' : 'complete'
  return {
    family: 'file-write',
    id: `write:${tu.id}`,
    provider,
    status,
    plane: 'committed',
    toolUseId: tu.id,
    startedAt: null,
    endedAt: null,
    filePath,
    content,
    lineCount: countLines(content),
    resultError: isError && result ? toolResultText(result) : null,
  }
}

export function fileWriteFromLive(
  block: SemanticLiveBlock,
  toolState: SemanticToolCallSnapshot | null,
  provider: AgentProviderKind,
): (FileWriteArtifact & { resultError: string | null }) | null {
  const id = block.toolUseId ?? block.callId ?? block.itemId ?? `live:${block.blockIndex}`
  // Prefer the authoritative parse once the input finalizes; fall back
  // to the single-pass partial scanner while streaming.
  const parsed = block.parsedInput
  let filePath: string | null = null
  let content = ''
  if (parsed && typeof parsed.file_path === 'string') {
    filePath = parsed.file_path
    content = typeof parsed.content === 'string' ? parsed.content : ''
  } else {
    const stream = extractStreamingWriteInput(block.inputJson ?? '')
    // No path yet → caller falls through to the generic card (raw
    // preview) — never a blank Write card (the old preview's rule).
    if (!stream.filePath) return null
    filePath = stream.filePath
    content = stream.partialContent ?? ''
  }
  const hasResult = block.resultAt != null || block.resultContent != null
  const status: ArtifactStatus =
    toolState?.status === 'error' || block.resultIsError === true
      ? 'error'
      : hasResult
        ? 'complete'
        : block.finalized === true
          ? 'running'
          : 'streaming'
  return {
    family: 'file-write',
    id: `write:${id}`,
    provider,
    status,
    plane: 'live',
    toolUseId: block.toolUseId ?? block.callId ?? null,
    startedAt: null,
    endedAt: block.resultAt ?? null,
    filePath,
    content,
    lineCount: countLines(content),
    resultError:
      block.resultIsError === true ? (block.resultContent ?? '(error)') : null,
  }
}

export const FileWriteCard = memo(function FileWriteCard({
  vm,
}: {
  vm: FileWriteArtifact & { resultError: string | null }
}) {
  const { workspaceRoot } = useContext(CodeRenderContext)
  const display = vm.filePath ? formatToolFilePath(vm.filePath, workspaceRoot) : null
  const language = normalizeCodeLanguage(null, vm.filePath)

  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-col gap-1">
        <div
          className="text-[13px] leading-[1.65] flex items-baseline gap-2 min-w-0"
          title={vm.filePath ?? undefined}
        >
          <span className="text-accent font-semibold flex-shrink-0">Write</span>
          {display && (
            <span
              className="text-ink-dim font-code text-[12px] truncate min-w-0"
              style={{ direction: 'rtl', textAlign: 'left' }}
            >
              {display}
            </span>
          )}
          {language !== 'plaintext' ? (
            <span className="text-[10px] text-ink-dim border border-border rounded px-1 py-px flex-shrink-0">
              {language}
            </span>
          ) : null}
          <span className="text-muted text-[11px] flex-shrink-0 tabular-nums">
            {vm.lineCount} line{vm.lineCount === 1 ? '' : 's'}
          </span>
          <StatusBadge status={vm.status} />
        </div>
        <StreamingCodeBlock
          code={vm.content}
          path={vm.filePath}
          blockKey={`write:${vm.id}`}
        />
        {(vm.status === 'complete' || vm.status === 'error') &&
        vm.lineCount > MONACO_OFFER_LINES ? (
          <ExpandSection summary="open in editor view">
            <CodeBlock
              code={vm.content}
              path={vm.filePath}
              workspaceRoot={workspaceRoot}
              codeId={`write-monaco:${vm.id}`}
              engine="monaco"
            />
          </ExpandSection>
        ) : null}
        {vm.resultError ? <OutputWell text={vm.resultError} isError ansi /> : null}
      </div>
    </MarkerRow>
  )
})
