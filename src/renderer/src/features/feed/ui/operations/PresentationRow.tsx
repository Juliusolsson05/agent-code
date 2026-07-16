import { memo } from 'react'

import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { asRecord } from '@shared/lib/asRecord'

import type { PresentationNode } from '@renderer/features/feed/presentation/types'
import { SafeMarkdownLink } from '@renderer/features/rendered-content/SafeMarkdownLink'
import { WorkIndicator } from '@renderer/features/feed/WorkIndicator'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { SegmentedMarkdown } from '@renderer/features/feed/ui/kit/SegmentedMarkdown'
import { StructuredOutput } from '@renderer/features/feed/ui/kit/StructuredOutput'
import { TextProse } from '@renderer/features/feed/ui/markdown'
import { SlashCommandRow, isSlashCommandText } from '@renderer/features/feed/ui/artifacts/slashCommand'
import { ThinkingBlock } from '@renderer/features/feed/ui/artifacts/thinking'
import { ImageBlockRow } from '@renderer/features/feed/ui/rows/ImageBlockRow'
import { EntryRow } from '@renderer/features/feed/ui/rows/EntryRow'
import { UserBand } from '@renderer/features/feed/ui/rows/primitives'
import { SemanticCollapsedActivityRow } from '@renderer/features/feed/ui/semantic/CollapsedActivityRow'
import { OperationRow } from '@renderer/features/feed/ui/operations/OperationRow'
import { CollaborationGroupRow } from '@renderer/features/feed/ui/operations/CollaborationGroupRow'

function CitationList({ citations }: { citations: unknown[] }) {
  return (
    <ol className="m-0 mt-1 space-y-1 pl-4 text-[11px] leading-[1.45] text-muted">
      {citations.map((citation, index) => {
        const record = asRecord(citation)
        const url =
          typeof record?.url === 'string'
            ? record.url
            : typeof record?.source_url === 'string'
              ? record.source_url
              : null
        const label =
          typeof record?.title === 'string'
            ? record.title
            : typeof record?.document_title === 'string'
              ? record.document_title
              : typeof record?.name === 'string'
                ? record.name
                : url ?? `Source ${index + 1}`
        const citedText =
          typeof record?.cited_text === 'string' ? record.cited_text.trim() : ''

        // Citation schemas differ across server tools and provider versions.
        // URL/title/cited_text are the stable useful intersection; unknown
        // metadata must not make the source disappear, so it still receives a
        // numbered label rather than depending on one provider discriminator.
        return (
          <li key={`${url ?? label}:${index}`} className="pl-0.5">
            {url ? (
              <SafeMarkdownLink
                href={url}
                className="text-accent underline break-words"
                title={url}
              >
                {label}
              </SafeMarkdownLink>
            ) : (
              <span className="text-ink-dim">{label}</span>
            )}
            {citedText ? (
              <span className="block line-clamp-2" title={citedText}>
                {citedText}
              </span>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

function MessageRow({ node }: { node: Extract<PresentationNode, { kind: 'message' }> }) {
  if (node.role === 'user' && isSlashCommandText(node.text)) {
    return <SlashCommandRow text={node.text} />
  }

  const content = node.streaming
    ? <SegmentedMarkdown text={node.text} blockKey={node.id} />
    : <TextProse text={node.text} />
  const row = (
    <MarkerRow marker={node.role === 'user' ? '❯' : '⏺'}>
      <div className="flex flex-col gap-2 min-w-0">
        {content}
        {node.citations.length > 0 ? <CitationList citations={node.citations} /> : null}
      </div>
    </MarkerRow>
  )
  return node.role === 'user' ? <UserBand>{row}</UserBand> : row
}

/**
 * One small top-level painter for the pure projection union.  It contains no
 * provider/tool dispatch: every operation, live or committed, enters the same
 * OperationRow below.  Keeping this switch exhaustive makes a newly-added
 * presentation kind a compile error instead of another silently missing row.
 */
type PresentationRowProps = {
  node: PresentationNode
  turnStartedAt: number | null
  toolHint: string | null
}

function sameArray<T>(left: readonly T[], right: readonly T[]): boolean {
  return left === right || (
    left.length === right.length && left.every((value, index) => value === right[index])
  )
}

/**
 * Projecting is pure and intentionally creates fresh wrapper objects. Default
 * React.memo would therefore repaint every restored row on every semantic
 * token, undoing the upstream ledger's identity-stability work. Compare the
 * actual source evidence per union member: stable committed entries stay cold,
 * while the one advancing live block still updates immediately.
 */
export function presentationRowPropsEqual(
  previous: PresentationRowProps,
  next: PresentationRowProps,
): boolean {
  const left = previous.node
  const right = next.node
  if (left.id !== right.id || left.kind !== right.kind) return false

  switch (left.kind) {
    case 'message':
      return right.kind === 'message' &&
        left.role === right.role &&
        left.text === right.text &&
        left.streaming === right.streaming &&
        sameArray(left.citations, right.citations)
    case 'thinking':
      return right.kind === 'thinking' &&
        left.text === right.text &&
        left.streaming === right.streaming &&
        left.redacted === right.redacted
    case 'image':
      return right.kind === 'image' && left.role === right.role && left.block === right.block
    case 'operation': {
      if (right.kind !== 'operation') return false
      const a = left.operation
      const b = right.operation
      return a.family === b.family &&
        a.lifecycle === b.lifecycle &&
        a.toolName === b.toolName &&
        a.classification.family === b.classification.family &&
        a.classification.confidence === b.classification.confidence &&
        a.classification.evidence === b.classification.evidence &&
        a.classification.displayToolName === b.classification.displayToolName &&
        a.committedToolUse === b.committedToolUse &&
        a.committedResult === b.committedResult &&
        sameArray(a.committedResults, b.committedResults) &&
        a.liveBlock === b.liveBlock &&
        a.liveToolState === b.liveToolState &&
        a.liveOutput === b.liveOutput &&
        sameArray(a.liveOutputs, b.liveOutputs) &&
        a.standaloneResult === b.standaloneResult &&
        sameArray(a.standaloneResults, b.standaloneResults) &&
        sameArray(a.sourceKeys, b.sourceKeys)
    }
    case 'operation-group':
      return right.kind === 'operation-group' &&
        sameArray(left.operationIds, right.operationIds) &&
        sameArray(left.toolUseIds, right.toolUseIds)
    case 'activity':
      return right.kind === 'activity' && left.unit === right.unit
    case 'system':
      if (right.kind !== 'system' || left.system.type !== right.system.type) return false
      if (left.system.type === 'entry') {
        return right.system.type === 'entry' && left.system.entry === right.system.entry
      }
      if (left.system.type === 'empty') {
        return right.system.type === 'empty' && left.system.provider === right.system.provider
      }
      return right.system.type === 'work' &&
        left.system.phase === right.system.phase &&
        left.system.toolName === right.system.toolName &&
        left.system.toolUseId === right.system.toolUseId &&
        previous.turnStartedAt === next.turnStartedAt &&
        previous.toolHint === next.toolHint
    case 'fallback':
      return right.kind === 'fallback' &&
        left.label === right.label &&
        left.value === right.value &&
        left.role === right.role
  }
}

export const PresentationRow = memo(function PresentationRow({
  node,
  turnStartedAt,
  toolHint,
}: PresentationRowProps) {
  switch (node.kind) {
    case 'message':
      return <MessageRow node={node} />
    case 'thinking':
      return (
        <ThinkingBlock
          text={node.text}
          streaming={node.streaming}
          redacted={node.redacted}
        />
      )
    case 'image':
      return <ImageBlockRow block={node.block} role={node.role} />
    case 'operation':
      return <OperationRow operation={node.operation} />
    case 'operation-group':
      return <CollaborationGroupRow toolUseIds={node.toolUseIds} />
    case 'activity':
      return <SemanticCollapsedActivityRow unit={node.unit} />
    case 'system':
      switch (node.system.type) {
        case 'entry':
          return <EntryRow entry={node.system.entry} />
        case 'work':
          return (
            <WorkIndicator
              phase={node.system.phase}
              turnStartedAt={turnStartedAt}
              toolName={node.system.toolName}
              toolHint={toolHint}
            />
          )
        case 'empty':
          return (
            <div className="flex min-h-[240px] flex-1 items-center justify-center">
              <div className="text-muted text-[12px]">
                {`waiting for ${getRendererProviderCapabilities(node.system.provider).name}…`}
              </div>
            </div>
          )
      }
    case 'fallback': {
      const fallback = (
        <MarkerRow marker="⏺" tone="muted">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-wider text-muted">
              Unsupported {node.label}
            </div>
            <StructuredOutput value={node.value} codeId={`fallback:${node.id}`} />
          </div>
        </MarkerRow>
      )
      return node.role === 'user' ? <UserBand>{fallback}</UserBand> : fallback
    }
  }
}, presentationRowPropsEqual)
