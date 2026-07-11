import { memo, useContext, useMemo } from 'react'

import { diffLines } from '@shared/parsers/lineDiff'
import { formatToolFilePath } from '@shared/paths/displayPath'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import type { AgentProviderKind } from '@shared/types/providerKind'

import {
  editInput,
  multiEditInput,
  partialEditInput,
} from '@providers/claude/renderer/extractors'
import {
  parseApplyPatch,
  partialApplyPatchInput,
  patchChangesFromResult,
} from '@providers/codex/renderer/extractors'

import { CodeRenderContext } from '@renderer/features/feed/context'
import { toolResultText } from '@renderer/features/feed/lib/helpers'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { DiffView, type DiffViewFile } from '@renderer/features/feed/ui/kit/DiffView'
import { OutputWell } from '@renderer/features/feed/ui/kit/OutputWell'
import { StatusBadge } from '@renderer/features/feed/ui/kit/StatusBadge'
import { StreamingCodeBlock } from '@renderer/features/feed/ui/kit/StreamingCodeBlock'
import type { SemanticLiveTurn } from '@renderer/session-runtime/state'

import type { ArtifactStatus, FileEditArtifact } from './types'

type SemanticLiveBlock = SemanticLiveTurn['blocks'][number]
type SemanticToolCallSnapshot = SemanticLiveTurn['lookups']['toolCallsById'][string]

// DiffCard — the ONE file-edit surface (spec §6): Claude Edit,
// MultiEdit, and Codex apply_patch, live and committed, through the
// same card and the same DiffView body.
//
// Live behavior (the [#285] convergence, generalized): the file path
// appears the moment its JSON string literal closes; the diff fills in
// as old_string/new_string stream (each render re-derives the partial
// diff — diffLines over partial strings is cheap and self-corrects);
// an apply_patch payload renders its parsed files as the grammar
// streams. Until even the path has arrived, the raw streaming input
// shows in a StreamingCodeBlock — never a blank card, never worse than
// the raw-JSON preview this replaces.
//
// Result handling: success stubs ("file updated successfully") are
// consumed silently — the diff IS the story and the ✓ badge is the
// confirmation (this also finally gives Codex patch successes a
// visible confirmation; they used to render literally nothing).
// ERRORS render loudly: the error text in a red OutputWell plus, for
// Codex patch failures, the per-file unified_diff tinted through
// DiffView (replacing the flat `language="diff"` CodeBlock path).

function editStatus(
  result: ToolResultBlock | null,
): ArtifactStatus {
  if (!result) return 'running'
  if (result.is_error === true) return 'error'
  return 'complete'
}

export function fileEditFromCommitted(
  tu: ToolUseBlock,
  result: ToolResultBlock | null,
  provider: AgentProviderKind,
): FileEditArtifact {
  let filePath: string | null = null
  let diffs: FileEditArtifact['diffs'] = []
  let patchFiles: FileEditArtifact['patchFiles'] = []

  if (tu.name === 'Edit') {
    const input = editInput(tu.input)
    filePath = input.filePath || null
    diffs = [diffLines(input.oldString, input.newString)]
  } else if (tu.name === 'MultiEdit') {
    const input = multiEditInput(tu.input)
    filePath = input.filePath || null
    diffs = input.edits.map(e => diffLines(e.oldString, e.newString))
  } else {
    // apply_patch
    patchFiles = parseApplyPatch(tu.input).map(f => ({
      path: f.path,
      action: f.action.toLowerCase() as 'add' | 'update' | 'delete',
      movedTo: f.movedTo ?? null,
      lines: f.lines,
    }))
  }

  const isError = result?.is_error === true
  // Codex patch failure: prefer the per-file unified diffs from the
  // result meta over the tool_use grammar (the meta reflects what the
  // apply actually did/failed on).
  if (isError && tu.name === 'apply_patch') {
    const changes = patchChangesFromResult(result)
    if (changes.length > 0) {
      patchFiles = changes.map(c => ({
        path: c.path,
        action: 'update' as const,
        movedTo: null,
        lines: c.lines,
      }))
    }
  }

  return {
    family: 'file-edit',
    id: `edit:${tu.id}`,
    provider,
    status: editStatus(result),
    plane: 'committed',
    toolUseId: tu.id,
    startedAt: null,
    endedAt: null,
    filePath,
    diffs,
    patchFiles,
    rawStreamingInput: null,
    resultError: isError && result ? toolResultText(result) : null,
  }
}

export function fileEditFromLive(
  block: SemanticLiveBlock,
  toolState: SemanticToolCallSnapshot | null,
  provider: AgentProviderKind,
): FileEditArtifact {
  const id = block.toolUseId ?? block.callId ?? block.itemId ?? `live:${block.blockIndex}`
  const name = block.toolName ?? ''
  const raw = block.argumentsJson ?? block.inputJson ?? ''

  let filePath: string | null = null
  let diffs: FileEditArtifact['diffs'] = []
  let patchFiles: FileEditArtifact['patchFiles'] = []
  let rawStreamingInput: string | null = null

  if (name === 'apply_patch') {
    // The payload may be the grammar directly or a JSON wrapper around
    // it; parseApplyPatch handles both via applyPatchText. A partial
    // grammar parses to however many complete file sections have
    // arrived — the card grows file by file.
    patchFiles = parseApplyPatch(
      block.parsedInput ?? partialApplyPatchInput(raw),
    ).map(f => ({
      path: f.path,
      action: f.action.toLowerCase() as 'add' | 'update' | 'delete',
      movedTo: f.movedTo ?? null,
      lines: f.lines,
    }))
    if (patchFiles.length === 0 && raw) rawStreamingInput = raw
  } else {
    const partial = partialEditInput(raw, block.parsedInput ?? null, name)
    if (partial) {
      if (name === 'MultiEdit') {
        const input = multiEditInput(partial)
        filePath = input.filePath || null
        diffs = input.edits.map(e => diffLines(e.oldString, e.newString))
      } else {
        const input = editInput(partial)
        filePath = input.filePath || null
        diffs = [diffLines(input.oldString, input.newString)]
      }
    } else if (raw) {
      rawStreamingInput = raw
    }
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
    family: 'file-edit',
    id: `edit:${id}`,
    provider,
    status,
    plane: 'live',
    toolUseId: block.toolUseId ?? block.callId ?? null,
    startedAt: null,
    endedAt: block.resultAt ?? null,
    filePath,
    diffs,
    patchFiles,
    rawStreamingInput,
    resultError:
      block.resultIsError === true ? (block.resultContent ?? '(error)') : null,
  }
}

const TOOL_LABEL: Record<string, string> = {
  Edit: 'Edit',
  MultiEdit: 'MultiEdit',
  apply_patch: 'ApplyPatch',
}

export const DiffCard = memo(function DiffCard({
  vm,
  toolName,
}: {
  vm: FileEditArtifact
  toolName: string
}) {
  const { workspaceRoot } = useContext(CodeRenderContext)
  const label = TOOL_LABEL[toolName] ?? toolName
  const display = vm.filePath ? formatToolFilePath(vm.filePath, workspaceRoot) : null

  const files: DiffViewFile[] = useMemo(() => {
    if (vm.patchFiles.length > 0) {
      return vm.patchFiles.map(f => ({
        path: f.path,
        action: f.action,
        movedTo: f.movedTo,
        lines: f.lines,
      }))
    }
    return vm.diffs.map((lines, i) => ({
      // The card header already names the (single) file for Edit/
      // MultiEdit — per-chunk headers only label the chunk.
      path: null,
      action: null,
      movedTo: null,
      lines,
      chunkLabel: vm.diffs.length > 1 ? `change ${i + 1} / ${vm.diffs.length}` : null,
    }))
  }, [vm.diffs, vm.patchFiles])

  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-col gap-1">
        <div
          className="text-[13px] leading-[1.65] flex items-baseline gap-2 min-w-0"
          title={vm.filePath ?? undefined}
        >
          <span className="text-accent font-semibold flex-shrink-0">{label}</span>
          {display && (
            // RTL truncation — filename stays visible (FileToolHeader port).
            <span
              className="text-ink-dim font-code text-[12px] truncate min-w-0"
              style={{ direction: 'rtl', textAlign: 'left' }}
            >
              {display}
            </span>
          )}
          {vm.diffs.length > 1 ? (
            <span className="text-muted text-[11px] flex-shrink-0">
              {vm.diffs.length} changes
            </span>
          ) : vm.patchFiles.length > 1 ? (
            <span className="text-muted text-[11px] flex-shrink-0">
              {vm.patchFiles.length} files
            </span>
          ) : null}
          <StatusBadge status={vm.status} />
        </div>
        {vm.rawStreamingInput !== null ? (
          // Nothing parseable yet — show the raw streaming input rather
          // than a blank card. Flips to the real diff on parse success
          // (same mounted card; the body swap is unavoidable because a
          // partial diff is unparseable by nature — spec §6).
          <StreamingCodeBlock
            code={vm.rawStreamingInput}
            language="json"
            blockKey={`edit-raw:${vm.id}`}
          />
        ) : (
          <DiffView
            files={files}
            showHeaders={vm.patchFiles.length > 0 || vm.diffs.length > 1}
          />
        )}
        {vm.resultError ? (
          <OutputWell text={vm.resultError} isError ansi />
        ) : null}
      </div>
    </MarkerRow>
  )
})
