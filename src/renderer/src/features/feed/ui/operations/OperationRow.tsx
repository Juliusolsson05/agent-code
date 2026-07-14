import { memo, type ReactNode } from 'react'

import { asRecord, parseJsonRecord } from '@shared/lib/asRecord'
import { detectGitIntent } from '@shared/git/gitDetect'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

import {
  prettifyToolName,
  smartHeadline,
} from '@providers/shared/renderer/rows/jsonToolPresentation'
import { patchResultMeta } from '@providers/codex/renderer/extractors'

import { useAppStore } from '@renderer/app-state/hooks'
import { toolResultText } from '@renderer/features/feed/lib/helpers'
import type {
  OperationLifecycle,
  OperationVM,
} from '@renderer/features/feed/presentation/types'
import { CommandCard } from '@renderer/features/feed/ui/artifacts/command'
import {
  DiffCard,
  PatchResultCard,
  fileEditFromCommitted,
  fileEditFromLive,
} from '@renderer/features/feed/ui/artifacts/fileEdit'
import {
  FileWriteCard,
  fileWriteFromCommitted,
  fileWriteFromLive,
} from '@renderer/features/feed/ui/artifacts/fileWrite'
import {
  ReadCard,
  readFromCommitted,
  readFromLive,
} from '@renderer/features/feed/ui/artifacts/fileRead'
import { TodoCard, todoFromCommitted, todoFromLive } from '@renderer/features/feed/ui/artifacts/todo'
import { WebCard, webFromCommitted, webFromLive } from '@renderer/features/feed/ui/artifacts/web'
import {
  ImageGenCard,
  imageGenFromCommitted,
  imageGenFromLive,
} from '@renderer/features/feed/ui/artifacts/imageGen'
import {
  commandFromCommitted,
  genericFromCommitted,
} from '@renderer/features/feed/ui/resolve/fromCommitted'
import {
  commandFromLive,
  genericFromLive,
  liveParsedInput,
} from '@renderer/features/feed/ui/resolve/fromLive'
import { GitCardRow } from '@renderer/features/git/ui/GitRows'
import { TaskSubagentRow } from '@renderer/features/feed/ui/rows/TaskSubagentRow'
import { AskUserQuestionRow } from '@renderer/features/feed/ui/semantic/AskUserQuestionRow'
import { AskUserQuestionAnsweredRow } from '@renderer/features/feed/ui/rows/AskUserQuestionAnsweredRow'
import { StructuredOperationCard } from '@renderer/features/feed/ui/operations/StructuredOperationCard'
import { StructuredOutput } from '@renderer/features/feed/ui/kit/StructuredOutput'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import type { ArtifactStatus } from '@renderer/features/feed/ui/artifacts/types'
import { ExpandSection } from '@renderer/features/feed/ui/kit/ExpandSection'
import { OutputWell } from '@renderer/features/feed/ui/kit/OutputWell'

function badgeStatus(lifecycle: OperationLifecycle): 'streaming' | 'running' | 'complete' | 'error' {
  switch (lifecycle) {
    case 'preparing':
    case 'streaming':
      return 'streaming'
    case 'running':
      return 'running'
    case 'complete':
      return 'complete'
    case 'error':
    case 'denied':
    case 'cancelled':
      return 'error'
  }
}

function withLifecycleStatus<T extends { status: ArtifactStatus }>(
  vm: T,
  lifecycle: OperationLifecycle,
): T {
  const status = badgeStatus(lifecycle)
  // OperationVM is the one lifecycle authority. The retained artifact adapters
  // decode family payloads, but their historical status heuristics cannot know
  // about all provider completion evidence (OpenCode sealed messages, Codex
  // input.status, separate Responses outputs). Overriding at this seam prevents
  // a debug receipt saying "complete" while the visible badge spins forever.
  return vm.status === status ? vm : { ...vm, status }
}

function unknownOutputText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    const text = value.map(item => {
      // Codex permits both arrays of plain strings and typed text blocks. The
      // old narrowing handled only the latter, so live stdout disappeared until
      // the committed mapper flattened it. Unknown members remain inspectable
      // JSON rather than being silently filtered out.
      if (typeof item === 'string') return item
      const recordText = asRecord(item)?.text
      if (typeof recordText === 'string') return recordText
      try {
        return JSON.stringify(item)
      } catch {
        return String(item)
      }
    }).join('\n')
    if (text) return text
  }
  if (value === undefined || value === null) return null
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function pluralOrCompatibility<T>(plural: readonly T[], single: T | null): T[] {
  return plural.length > 0 ? [...plural] : single === null ? [] : [single]
}

function liveOutputEvents(operation: OperationVM): unknown[] {
  if (operation.liveOutputs.length > 0) return operation.liveOutputs
  return operation.liveOutput === undefined ? [] : [operation.liveOutput]
}

function liveOutputsAsCommittedResult(
  operation: OperationVM,
  toolUse: ToolUseBlock,
): ToolResultBlock | null {
  const outputs = liveOutputEvents(operation)
  if (outputs.length === 0) return null

  // The ownership ledger deliberately allows a committed tool_use and its live
  // output to coexist until the DURABLE tool_result lands (dump invariant 10).
  // In that interval there may be no live call block to feed a live resolver:
  // the committed call already owns it. Adapt only the output into the common
  // result contract so the mature committed resolver can retain the real command
  // and params while painting stdout immediately. This is presentation-only;
  // it never enters transcript indexes or pretends the durable result exists.
  const content = outputs
    .map(unknownOutputText)
    .filter((value): value is string => value !== null)
    .join('\n')
  return {
    type: 'tool_result',
    tool_use_id: toolUse.id,
    content,
    is_error: resultIsError(operation),
  }
}

function resultEventValues(operation: OperationVM): unknown[] {
  const live = liveOutputEvents(operation)
  if (live.length > 0) return live
  const committed = pluralOrCompatibility(
    operation.committedResults,
    operation.committedResult,
  )
  if (committed.length > 0) return committed.map(result => result.content)
  const standalone = pluralOrCompatibility(
    operation.standaloneResults,
    operation.standaloneResult,
  )
  if (standalone.length > 0) return standalone.map(result => result.content)
  const block = operation.liveBlock
  return block?.output !== undefined
    ? [block.output]
    : block?.resultContent !== undefined
      ? [block.resultContent]
      : []
}

function packedEventValues(values: unknown[]): unknown {
  if (values.length === 0) return undefined
  return values.length === 1 ? values[0] : values
}

/**
 * Adapt a plural result stream to legacy family resolvers without discarding it.
 *
 * The preferred result owns typed metadata (`codex.kind`, exit code, patch
 * files), while text from every event is concatenated in source order and any
 * error is monotonic. Structured/generic rows use resultEventValues directly so
 * their non-text payloads remain intact as well.
 */
function combinedToolResult(
  results: readonly ToolResultBlock[],
  preferred: ToolResultBlock | null,
): ToolResultBlock | null {
  const all = pluralOrCompatibility(results, preferred)
  if (all.length === 0) return null
  if (all.length === 1) return all[0] ?? null
  const base = preferred ?? all[0]
  if (!base) return null
  return {
    ...base,
    content: all.map(toolResultText).join('\n'),
    is_error: all.some(result => result.is_error === true),
  }
}

/**
 * A separate Responses output item is presentation evidence for the original
 * call, not a second operation.  Existing family resolvers already understand
 * `resultContent`, so adapt the immutable block locally rather than adding a
 * second result branch to every card.
 */
function liveBlockWithOutput(operation: OperationVM): OperationVM['liveBlock'] {
  const block = operation.liveBlock
  const outputs = liveOutputEvents(operation)
  if (!block || outputs.length === 0) return block
  const packed = packedEventValues(outputs)
  const text = outputs
    .map(unknownOutputText)
    .filter((value): value is string => value !== null)
    .join('\n')
  return {
    ...block,
    output: packed,
    resultContent: (block.resultContent ?? text) || undefined,
    resultAt: block.resultAt ?? 0,
  }
}

function resultValue(operation: OperationVM): unknown {
  return packedEventValues(resultEventValues(operation))
}

function resultIsError(operation: OperationVM): boolean {
  return (
    operation.committedResults.some(result => result.is_error === true) ||
    operation.committedResult?.is_error === true ||
    operation.standaloneResults.some(result => result.is_error === true) ||
    operation.standaloneResult?.is_error === true ||
    operation.liveBlock?.resultIsError === true ||
    operation.lifecycle === 'error'
  )
}

type CodexSpawnJoin = { agentId: string | null; nickname: string | null }

function codexSpawnJoin(value: unknown): CodexSpawnJoin | null {
  const record = asRecord(value) ?? (
    typeof value === 'string' ? parseJsonRecord(value) : null
  )
  if (!record) return null
  const agentId =
    typeof record.agent_id === 'string'
      ? record.agent_id
      : typeof record.agentId === 'string'
        ? record.agentId
        : null
  const nickname = typeof record.nickname === 'string' ? record.nickname : null
  return agentId || nickname ? { agentId, nickname } : null
}

function operationParams(operation: OperationVM): Record<string, unknown> | null {
  if (operation.classification.structuredInput) {
    return operation.classification.structuredInput
  }
  if (operation.committedToolUse) {
    return asRecord(operation.committedToolUse.input) ??
      (typeof operation.committedToolUse.input === 'string'
        ? parseJsonRecord(operation.committedToolUse.input)
        : null)
  }
  return operation.liveBlock ? liveParsedInput(operation.liveBlock) : null
}

function rawInput(operation: OperationVM): string | null {
  if (operation.liveBlock) {
    return operation.liveBlock.argumentsJson ?? operation.liveBlock.inputJson ?? null
  }
  return typeof operation.committedToolUse?.input === 'string'
    ? operation.committedToolUse.input
    : null
}

function sourceToolForDisplay(operation: OperationVM): ToolUseBlock {
  if (operation.committedToolUse) return operation.committedToolUse
  const live = operation.liveBlock
  return {
    type: 'tool_use',
    id: operation.correlationId,
    name: operation.toolName,
    input: live ? liveParsedInput(live) ?? {} : {},
  }
}

function CollaborationBody({ operation }: { operation: OperationVM }) {
  const block = sourceToolForDisplay(operation)
  const values = resultEventValues(operation)
  // Codex spawn output is a JOIN ACK ({agent_id,nickname}), not the child's
  // final answer. Treating it as a report made a raw protocol object look like
  // completed work. Keep the useful identity as compact metadata and reserve
  // StructuredOutput for actual report events (Claude Agent/Task results, or a
  // future Codex result whose shape is not the known join envelope).
  const joinValues = operation.provider === 'codex'
    ? values.map(codexSpawnJoin)
    : values.map(() => null)
  const reports = values.filter((_, index) => joinValues[index] === null)
  const output = packedEventValues(reports)
  return (
    <div>
      <TaskSubagentRow block={block} />
      {joinValues.map((join, index) => join ? (
        <MarkerRow key={`${join.agentId ?? join.nickname ?? 'join'}:${index}`} marker="⎿" tone="muted">
          <div
            data-codex-spawn-join
            className="text-[11px] leading-[1.55] text-muted"
          >
            joined{join.nickname ? ` ${join.nickname}` : ''}
            {join.agentId ? ` · ${join.agentId}` : ''}
          </div>
        </MarkerRow>
      ) : null)}
      {/* Claude's Agent/Task tool_result contains the child's final report.
          The fleet row historically rendered watcher state but silently lost
          this durable result. Keep it in the same operation shell so pruning a
          watcher can never erase the work product. */}
      {output !== undefined && output !== null && unknownOutputText(output)?.trim() ? (
        <StructuredOutput
          value={output}
          isError={resultIsError(operation)}
          codeId={`collaboration-result:${operation.id}`}
        />
      ) : null}
    </div>
  )
}

function StructuredBody({ operation }: { operation: OperationVM }) {
  const params = operationParams(operation)
  const pretty = prettifyToolName(operation.toolName)
  return (
    <StructuredOperationCard
      id={operation.id}
      family={operation.family}
      toolName={operation.toolName}
      displayName={pretty.display}
      status={badgeStatus(operation.lifecycle)}
      summary={smartHeadline(params)?.value ?? null}
      params={params}
      rawInput={rawInput(operation)}
      parseError={operation.liveBlock?.parseError ?? null}
      result={resultValue(operation)}
      resultIsError={resultIsError(operation)}
      server={pretty.mcpServer}
    />
  )
}

function renderDedicatedBody(operation: OperationVM, customRendering: boolean): ReactNode {
  const committed = operation.committedToolUse
  const durableCommittedResult = combinedToolResult(
    operation.committedResults,
    operation.committedResult,
  )
  const committedResult = durableCommittedResult ?? (
    committed ? liveOutputsAsCommittedResult(operation, committed) : null
  )
  const standaloneResult = combinedToolResult(
    operation.standaloneResults,
    operation.standaloneResult,
  )
  const live = liveBlockWithOutput(operation)
  const toolState = operation.liveToolState
  const provider = operation.provider
  const sourceToolName = committed?.name ?? live?.toolName ?? operation.toolName
  const sourceIsUnifiedExec = sourceToolName === 'exec'
  const isGenericNestedUnifiedCall = Boolean(
    sourceIsUnifiedExec && operation.classification.displayToolName,
  )

  // A result-rich live block is preferable during the narrow interval where a
  // committed tool_use has landed but its paired result index has not.  This is
  // evidence selection, not a visual plane fork: both paths create the exact
  // same family VM and card.
  const preferLive = Boolean(
    live && (!committed || (!committedResult && (
      live.resultAt != null || live.resultContent != null || liveOutputEvents(operation).length > 0
    ))),
  )

  // apply_patch/exec_command/write_stdin/wait have dedicated partial decoders.
  // Other tools nested in unified exec still get their proven family/name and
  // parsed object args, but pretending the outer JS wrapper is a native
  // Write/Web/Todo payload would feed the wrong schema to those cards.
  if (
    isGenericNestedUnifiedCall &&
    (operation.family === 'file-change' ||
      operation.family === 'command' ||
      operation.family === 'terminal-interaction')
  ) {
    return <StructuredBody operation={operation} />
  }

  if (operation.family === 'file-change') {
    const standalone = standaloneResult
    if (!committed && !live && standalone) {
      const patch = patchResultMeta(standalone)
      if (patch.isPatchResult) {
        return (
          <PatchResultCard
            files={patch.files}
            diffs={patch.diffs}
            success={patch.success && standalone.is_error !== true}
            stderr={toolResultText(standalone)}
          />
        )
      }
    }
    const fileToolName = sourceToolName.toLowerCase()
    if (fileToolName === 'write' || fileToolName === 'write_file') {
      if (preferLive && live) {
        const vm = fileWriteFromLive(live, toolState, provider)
        return vm
          ? <FileWriteCard vm={withLifecycleStatus(vm, operation.lifecycle)} />
          : <StructuredBody operation={operation} />
      }
      if (committed) {
        return <FileWriteCard vm={withLifecycleStatus(
          fileWriteFromCommitted(committed, committedResult, provider),
          operation.lifecycle,
        )} />
      }
      if (live) {
        const vm = fileWriteFromLive(live, toolState, provider)
        return vm
          ? <FileWriteCard vm={withLifecycleStatus(vm, operation.lifecycle)} />
          : <StructuredBody operation={operation} />
      }
    }
    if (preferLive && live) {
      return <DiffCard vm={withLifecycleStatus(
        fileEditFromLive(live, toolState, provider),
        operation.lifecycle,
      )} toolName={live.toolName === 'exec' ? 'apply_patch' : live.toolName ?? operation.toolName} />
    }
    if (committed) {
      return <DiffCard vm={withLifecycleStatus(
        fileEditFromCommitted(committed, committedResult, provider),
        operation.lifecycle,
      )} toolName={committed.name === 'exec' ? 'apply_patch' : committed.name} />
    }
    if (live) {
      return <DiffCard vm={withLifecycleStatus(
        fileEditFromLive(live, toolState, provider),
        operation.lifecycle,
      )} toolName={live.toolName === 'exec' ? 'apply_patch' : live.toolName ?? operation.toolName} />
    }
  }

  if (operation.family === 'command' || operation.family === 'terminal-interaction') {
    const resolvedVm = preferLive && live
      ? commandFromLive(live, toolState, provider)
      : committed
        ? commandFromCommitted(committed, committedResult, provider)
        : live
          ? commandFromLive(live, toolState, provider)
          : null
    const vm = resolvedVm
      ? withLifecycleStatus(resolvedVm, operation.lifecycle)
      : null
    if (vm) {
      const intent = detectGitIntent(vm.command)
      // Git widgets interpret a complete stdout snapshot. Mounting them while a
      // command is still running turns an empty prefix into false claims such
      // as "no changes" and hides the authoritative lifecycle badge. Keep the
      // normal streaming command surface until successful completion; errors
      // retain raw ANSI/exit evidence rather than being parsed as success UI.
      if (customRendering && intent && vm.status === 'complete') {
        return (
          <div className="space-y-1">
            <GitCardRow intent={intent} output={vm.output ?? ''} />
            {vm.output ? (
              <ExpandSection summary="Raw command output">
                {/* Git parsing adds a purpose-built view; it never becomes the
                    source of truth. Keep exact ANSI bytes available through the
                    same bounded/copyable output primitive as ordinary commands. */}
                <OutputWell text={vm.output} ansi />
              </ExpandSection>
            ) : null}
          </div>
        )
      }
      return <CommandCard vm={vm} />
    }
  }

  if (operation.family === 'read' && !sourceIsUnifiedExec) {
    if (preferLive && live) return <ReadCard vm={withLifecycleStatus(readFromLive(live, toolState, provider), operation.lifecycle)} />
    if (committed) return <ReadCard vm={withLifecycleStatus(readFromCommitted(committed, committedResult, provider), operation.lifecycle)} />
    if (live) return <ReadCard vm={withLifecycleStatus(readFromLive(live, toolState, provider), operation.lifecycle)} />
  }

  if (operation.family === 'search' && !sourceIsUnifiedExec) {
    const name = committed?.name ?? live?.toolName ?? operation.toolName
    if (name === 'tool_search' || name === 'tool_search_call' || name === 'ToolSearch') {
      if (preferLive && live) return <WebCard vm={withLifecycleStatus(webFromLive(live, toolState, provider), operation.lifecycle)} toolLabel="Tool search" />
      if (committed) return <WebCard vm={withLifecycleStatus(webFromCommitted(committed, committedResult, provider), operation.lifecycle)} toolLabel="Tool search" />
      if (live) return <WebCard vm={withLifecycleStatus(webFromLive(live, toolState, provider), operation.lifecycle)} toolLabel="Tool search" />
    }
    if (['Grep', 'Glob', 'LS', 'grep', 'glob', 'ls'].includes(name)) {
      if (preferLive && live) return <ReadCard vm={withLifecycleStatus(readFromLive(live, toolState, provider), operation.lifecycle)} />
      if (committed) return <ReadCard vm={withLifecycleStatus(readFromCommitted(committed, committedResult, provider), operation.lifecycle)} />
      if (live) return <ReadCard vm={withLifecycleStatus(readFromLive(live, toolState, provider), operation.lifecycle)} />
    }
  }

  if (operation.family === 'web' && !sourceIsUnifiedExec) {
    if (preferLive && live) return <WebCard vm={withLifecycleStatus(webFromLive(live, toolState, provider), operation.lifecycle)} />
    if (committed) return <WebCard vm={withLifecycleStatus(webFromCommitted(committed, committedResult, provider), operation.lifecycle)} />
    if (live) return <WebCard vm={withLifecycleStatus(webFromLive(live, toolState, provider), operation.lifecycle)} />
  }

  if (
    operation.family === 'task-plan' &&
    !sourceIsUnifiedExec &&
    /^(?:TodoWrite|todowrite)$/i.test(operation.toolName)
  ) {
    if (preferLive && live) return <TodoCard vm={withLifecycleStatus(todoFromLive(live, toolState, provider), operation.lifecycle)} label={operation.toolName} />
    if (committed) return <TodoCard vm={withLifecycleStatus(todoFromCommitted(committed, committedResult, provider), operation.lifecycle)} label={operation.toolName} />
    if (live) return <TodoCard vm={withLifecycleStatus(todoFromLive(live, toolState, provider), operation.lifecycle)} label={operation.toolName} />
  }

  if (operation.family === 'question') {
    // AskUserQuestion is backed by Claude's real headless picker resolver.
    // Codex request_user_input has a different host interaction contract; it
    // remains fully structured and visible here, but must never dispatch the
    // Claude-specific answer action merely because both belong to "question".
    if (
      operation.toolName === 'AskUserQuestion' &&
      live &&
      !committedResult &&
      live.resultAt == null
    ) {
      return <AskUserQuestionRow block={live} />
    }
    if (operation.toolName === 'AskUserQuestion' && committed) {
      return <AskUserQuestionAnsweredRow block={committed} result={committedResult} />
    }
  }

  if (
    operation.family === 'collaboration' &&
    !sourceIsUnifiedExec &&
    /^(?:Agent|Task|spawn_agent|orchestration_create_agent|mcp__[^]*__orchestration_create_agent)$/.test(operation.toolName)
  ) {
    return <CollaborationBody operation={operation} />
  }

  if (
    operation.family === 'image' &&
    !sourceIsUnifiedExec &&
    /^(?:image_generation|image_generation_call|imagegen)$/i.test(operation.toolName)
  ) {
    if (preferLive && live) return <ImageGenCard vm={withLifecycleStatus(imageGenFromLive(live, toolState, provider), operation.lifecycle)} />
    if (committed) return <ImageGenCard vm={withLifecycleStatus(imageGenFromCommitted(committed, committedResult, provider), operation.lifecycle)} />
    if (live) return <ImageGenCard vm={withLifecycleStatus(imageGenFromLive(live, toolState, provider), operation.lifecycle)} />
  }

  // Preserve the mature generic VM parsing as a final adapter when it has
  // already received a normal tool source. The component now delegates to the
  // structured card, so this is reuse of extraction logic, not a second UI.
  if (committed && operation.family === 'generic') {
    const vm = genericFromCommitted(committed, committedResult, provider)
    return <StructuredOperationCard
      id={operation.id}
      family={operation.family}
      toolName={vm.toolName}
      displayName={vm.prettyName}
      status={badgeStatus(operation.lifecycle)}
      summary={vm.headline}
      params={vm.params}
      rawInput={typeof committed.input === 'string' ? committed.input : null}
      parseError={vm.parseError}
      result={resultValue(operation)}
      resultIsError={vm.resultIsError}
      server={vm.mcp?.server}
    />
  }
  if (live && operation.family === 'generic') {
    const vm = genericFromLive(live, toolState, provider)
    return <StructuredOperationCard
      id={operation.id}
      family={operation.family}
      toolName={vm.toolName}
      displayName={vm.prettyName}
      status={badgeStatus(operation.lifecycle)}
      summary={vm.headline}
      params={vm.params}
      rawInput={vm.params === null ? vm.paramsJson || null : null}
      parseError={vm.parseError}
      result={resultValue(operation) ?? vm.resultText}
      resultIsError={vm.resultIsError}
      server={vm.mcp?.server}
    />
  }

  return <StructuredBody operation={operation} />
}

/**
 * The one mounted shell for an operation's complete lifecycle.
 *
 * Feed keys this component by provider correlation id, so semantic streaming,
 * result arrival, and transcript commitment update props on this same DOM node.
 * Dedicated family bodies may enrich as evidence becomes available, but the
 * operation never disappears and reappears as a different row.
 */
export const OperationRow = memo(function OperationRow({
  operation,
}: {
  operation: OperationVM
}) {
  const customRendering = useAppStore(state => state.settings.customRendering)
  return (
    <div
      data-operation-id={operation.id}
      data-operation-family={operation.family}
      data-operation-sources={operation.sourceKeys.join(' ')}
    >
      {renderDedicatedBody(operation, customRendering)}
    </div>
  )
})
