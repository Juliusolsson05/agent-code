import { memo, useContext } from 'react'

import { formatToolFilePath } from '@shared/paths/displayPath'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import type { AgentProviderKind } from '@shared/types/providerKind'

import { CodeRenderContext } from '@renderer/features/feed/context'
import {
  stripLineNumberPrefix,
  toolResultText,
} from '@renderer/features/feed/lib/helpers'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { ExpandSection } from '@renderer/features/feed/ui/kit/ExpandSection'
import { OutputWell } from '@renderer/features/feed/ui/kit/OutputWell'
import { StatusBadge } from '@renderer/features/feed/ui/kit/StatusBadge'
import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import type { SemanticLiveTurn } from '@renderer/session-runtime/state'

import type { ArtifactStatus, ReadArtifact } from './types'

type SemanticLiveBlock = SemanticLiveTurn['blocks'][number]
type SemanticToolCallSnapshot = SemanticLiveTurn['lookups']['toolCallsById'][string]

// ReadCard — the ONE lookup surface (spec §6): Read, Grep, Glob, LS.
// The collapsed one-liner IS the design: lookups are churn, and the
// old rendering split them across a generic tool_use row (bare name +
// params slab) and a special-cased result branch buried inside the
// shared ToolResultRow (hardcoded by tool name — audit gap #9). One
// card now owns both halves:
//
//   ⏺ Read src/foo.ts                              ✓
//   ⎿ ▸ Read 240 lines            ← ExpandSection, Monaco on first open
//
// Behavior ported from ToolResultRow's Read/Grep branches: the `N→`
// line-number prefix is stripped before display (the code renderer
// numbers lines itself), Monaco mounts only behind first-open, Grep
// results keep language-aware coloring via path detection. Glob/LS
// results render as a monospace file list.

function toolKind(name: string): ReadArtifact['kind'] {
  if (name === 'Grep') return 'grep'
  if (name === 'Glob') return 'glob'
  if (name === 'LS') return 'ls'
  return 'read'
}

function readTarget(input: Record<string, unknown> | null): string | null {
  if (!input) return null
  if (typeof input.file_path === 'string') return input.file_path
  if (typeof input.path === 'string') return input.path
  return null
}

function readPattern(input: Record<string, unknown> | null): string | null {
  if (!input) return null
  if (typeof input.pattern === 'string') return input.pattern
  if (typeof input.glob === 'string') return input.glob
  return null
}

export function readFromCommitted(
  tu: ToolUseBlock,
  result: ToolResultBlock | null,
  provider: AgentProviderKind,
): ReadArtifact {
  const input = (tu.input ?? null) as Record<string, unknown> | null
  const kind = toolKind(tu.name)
  const rawText = result ? toolResultText(result).replace(/\s+$/, '') : null
  return {
    family: 'file-read',
    id: `read:${tu.id}`,
    provider,
    status: !result ? 'running' : result.is_error === true ? 'error' : 'complete',
    plane: 'committed',
    toolUseId: tu.id,
    startedAt: null,
    endedAt: null,
    kind,
    target: readTarget(input),
    pattern: readPattern(input),
    resultText:
      rawText !== null && kind === 'read' ? stripLineNumberPrefix(rawText) : rawText,
    resultIsError: result?.is_error === true,
  }
}

export function readFromLive(
  block: SemanticLiveBlock,
  toolState: SemanticToolCallSnapshot | null,
  provider: AgentProviderKind,
): ReadArtifact {
  const id = block.toolUseId ?? block.callId ?? block.itemId ?? `live:${block.blockIndex}`
  const kind = toolKind(block.toolName ?? '')
  const input = block.parsedInput ?? null
  const raw = toolState?.resultContent ?? block.resultContent ?? null
  const hasResult = block.resultAt != null || raw != null
  const status: ArtifactStatus =
    toolState?.status === 'error' || block.resultIsError === true
      ? 'error'
      : hasResult
        ? 'complete'
        : block.finalized === true
          ? 'running'
          : 'streaming'
  return {
    family: 'file-read',
    id: `read:${id}`,
    provider,
    status,
    plane: 'live',
    toolUseId: block.toolUseId ?? block.callId ?? null,
    startedAt: null,
    endedAt: block.resultAt ?? null,
    kind,
    target: readTarget(input),
    pattern: readPattern(input),
    resultText: raw !== null && kind === 'read' ? stripLineNumberPrefix(raw) : raw,
    resultIsError: block.resultIsError === true,
  }
}

const KIND_LABEL: Record<ReadArtifact['kind'], string> = {
  read: 'Read',
  grep: 'Grep',
  glob: 'Glob',
  ls: 'LS',
}

export const ReadCard = memo(function ReadCard({ vm }: { vm: ReadArtifact }) {
  const { workspaceRoot } = useContext(CodeRenderContext)
  const display = vm.target ? formatToolFilePath(vm.target, workspaceRoot) : null
  const lineCount = vm.resultText ? vm.resultText.split('\n').filter(Boolean).length : 0

  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-col gap-0.5">
        <div
          className="text-[13px] leading-[1.65] flex items-baseline gap-2 min-w-0"
          title={vm.target ?? undefined}
        >
          <span className="text-accent font-semibold flex-shrink-0">
            {KIND_LABEL[vm.kind]}
          </span>
          {vm.pattern ? (
            <span className="font-code text-[12px] text-ink flex-shrink-0 break-all">
              "{vm.pattern}"
            </span>
          ) : null}
          {display ? (
            <span
              className="text-ink-dim font-code text-[12px] truncate min-w-0"
              style={{ direction: 'rtl', textAlign: 'left' }}
            >
              {display}
            </span>
          ) : null}
          <StatusBadge status={vm.status} />
        </div>
        {vm.resultIsError && vm.resultText ? (
          <OutputWell text={vm.resultText} isError ansi />
        ) : vm.resultText ? (
          <MarkerRow marker="⎿" tone="muted">
            <ExpandSection
              summary={
                vm.kind === 'grep' ? (
                  <>
                    <span className="text-ink font-semibold">{lineCount}</span>{' '}
                    {lineCount === 1 ? 'match line' : 'match lines'}
                  </>
                ) : vm.kind === 'glob' || vm.kind === 'ls' ? (
                  <>
                    <span className="text-ink font-semibold">{lineCount}</span>{' '}
                    {lineCount === 1 ? 'entry' : 'entries'}
                  </>
                ) : (
                  <>
                    Read <span className="text-ink font-semibold">{lineCount}</span>{' '}
                    {lineCount === 1 ? 'line' : 'lines'}
                  </>
                )
              }
            >
              {vm.kind === 'glob' || vm.kind === 'ls' ? (
                <pre className="font-code text-[12px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-all m-0 max-h-[360px] overflow-auto">
                  {vm.resultText}
                </pre>
              ) : (
                <CodeBlock
                  code={vm.resultText}
                  path={vm.target}
                  workspaceRoot={workspaceRoot}
                  codeId={`read:${vm.id}`}
                  engine="monaco"
                  allowAutoDetect
                />
              )}
            </ExpandSection>
          </MarkerRow>
        ) : null}
      </div>
    </MarkerRow>
  )
})
