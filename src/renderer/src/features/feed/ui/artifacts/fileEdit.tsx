import { memo, useContext, useMemo } from 'react'

import { diffLines, streamingDiffLines } from '@shared/parsers/lineDiff'
import { formatToolFilePath } from '@shared/paths/displayPath'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import type { AgentProviderKind } from '@shared/types/providerKind'

import {
  STREAMING_EDIT_HEADER_SCAN_CHARS,
  STREAMING_EDIT_PREVIEW_LINES,
  STREAMING_EDIT_PREVIEW_RAW_CHARS,
  STREAMING_MULTI_EDIT_PREVIEW_ITEMS,
  editInput,
  multiEditInput,
  partialEditPreview,
} from '@providers/claude/renderer/extractors'
import {
  classifyUnifiedExecScript,
  applyPatchText,
  parseApplyPatch,
  partialApplyPatchInput,
  patchChangesFromResult,
  unifiedDiffToLines,
  unifiedExecScript,
} from '@providers/codex/renderer/extractors'

import { CodeRenderContext } from '@renderer/features/feed/context'
import { toolResultText } from '@renderer/features/feed/lib/helpers'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { DiffView, type DiffViewFile } from '@renderer/features/feed/ui/kit/DiffView'
import { OutputWell } from '@renderer/features/feed/ui/kit/OutputWell'
import { StatusBadge } from '@renderer/features/feed/ui/kit/StatusBadge'
import { StreamingCodeBlock } from '@renderer/features/feed/ui/kit/StreamingCodeBlock'
import { ExpandSection } from '@renderer/features/feed/ui/kit/ExpandSection'
import { CodeBlock } from '@renderer/lib/code/CodeBlock'
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
// as old_string/new_string stream. Partial strings use a linear common-prefix
// diff; the minimal LCS runs once only after input finalizes. Running the LCS
// matrix per token was quadratic/cubic over a large edit stream.
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

function cappedDiffLines(lines: FileEditArtifact['diffs'][number], limit: number) {
  if (lines.length <= limit) return { lines, truncated: false }
  // A live replacement naturally orders removals before additions. Keeping only
  // the head would therefore show the red half and hide exactly what the agent
  // is writing. Head+tail retains both sides (and mirrors OutputWell's evidence
  // policy) while the warning below makes the missing middle explicit.
  const headCount = Math.ceil(limit / 2)
  const tailCount = Math.floor(limit / 2)
  return {
    lines: [
      ...lines.slice(0, headCount),
      ...(tailCount > 0 ? lines.slice(-tailCount) : []),
    ],
    truncated: true,
  }
}

function capStreamingDiffs(diffs: FileEditArtifact['diffs']): {
  diffs: FileEditArtifact['diffs']
  truncated: boolean
} {
  let remainingLines = STREAMING_EDIT_PREVIEW_LINES
  let remainingNonEmpty = diffs.filter(lines => lines.length > 0).length
  let truncated = false

  const capped = diffs.map(lines => {
    if (lines.length === 0) return lines
    // Divide the remaining budget across the remaining chunks. MultiEdit must
    // not let one huge first replacement consume every row and make later
    // edits disappear. The provider decoder separately caps chunks at 32, so
    // this allocation always grants at least one line per non-empty chunk.
    const share = Math.max(1, Math.floor(remainingLines / remainingNonEmpty))
    const result = cappedDiffLines(lines, share)
    remainingLines -= result.lines.length
    remainingNonEmpty -= 1
    truncated ||= result.truncated
    return result.lines
  })

  return { diffs: capped, truncated }
}

export function fileEditFromCommitted(
  tu: ToolUseBlock,
  result: ToolResultBlock | null,
  provider: AgentProviderKind,
): FileEditArtifact {
  let filePath: string | null = null
  let diffs: FileEditArtifact['diffs'] = []
  let patchFiles: FileEditArtifact['patchFiles'] = []
  let parsedPatchSource: string | null = null

  if (tu.name.toLowerCase() === 'edit' || tu.name.toLowerCase() === 'edit_file') {
    const input = editInput(tu.input)
    filePath = input.filePath || null
    diffs = [diffLines(input.oldString, input.newString)]
  } else if (tu.name.toLowerCase() === 'multiedit') {
    const input = multiEditInput(tu.input)
    filePath = input.filePath || null
    diffs = input.edits.map(e => diffLines(e.oldString, e.newString))
  } else {
    // apply_patch — either the classic tool or a unified-exec script
    // wrapping tools.apply_patch("*** Begin Patch…") (modern Codex).
    const source =
      tu.name === 'exec'
        ? (() => {
            const action = classifyUnifiedExecScript(unifiedExecScript(tu.input))
            return action?.kind === 'apply_patch' ? { raw: action.patchText } : tu.input
          })()
        : tu.input
    parsedPatchSource = applyPatchText(source) || null
    patchFiles = parseApplyPatch(source).map(f => ({
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
    previewState: 'exact',
    sourceInput: null,
    parsedPatchSource,
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
  let previewState: FileEditArtifact['previewState'] = 'receiving'
  let sourceInput: string | null = null
  let parsedPatchSource: string | null = null

  if (name === 'apply_patch' || name === 'patch' || name === 'exec') {
    // The payload may be the grammar directly or a JSON wrapper around
    // it; parseApplyPatch handles both via applyPatchText. A partial
    // grammar parses to however many complete file sections have
    // arrived — the card grows file by file.
    // Unified exec: pull the patch literal out of the streaming JS
    // script (partial-safe — the diff grows file by file as the
    // literal streams). Classic apply_patch keeps the wrapper decode.
    const source =
      name === 'exec'
        ? (() => {
            const action = classifyUnifiedExecScript(raw)
            return action?.kind === 'apply_patch' ? { raw: action.patchText } : { raw: '' }
          })()
        : block.parsedInput ?? partialApplyPatchInput(raw)
    parsedPatchSource = applyPatchText(source) || null
    patchFiles = parseApplyPatch(source).map(f => ({
      path: f.path,
      action: f.action.toLowerCase() as 'add' | 'update' | 'delete',
      movedTo: f.movedTo ?? null,
      lines: f.lines,
    }))
    if (patchFiles.length === 0 && raw) rawStreamingInput = raw
    previewState = block.parsedInput || block.finalized === true ? 'exact' : 'partial'
  } else {
    const exactInput = block.parsedInput ?? null
    const preview = partialEditPreview(raw, exactInput, name)
    if (preview.input) {
      // `finalized` only says transport bytes stopped. A malformed/truncated
      // provider object can be finalized without becoming parsedInput; only the
      // parsed object is authoritative enough for the minimal LCS. Otherwise
      // keep the honest provisional prefix/suffix diff and its cap warning.
      const deriveDiff = exactInput ? diffLines : streamingDiffLines
      if (name.toLowerCase() === 'multiedit') {
        const input = multiEditInput(preview.input)
        filePath = input.filePath || null
        diffs = input.edits.map(e => deriveDiff(e.oldString, e.newString))
      } else {
        const input = editInput(preview.input)
        filePath = input.filePath || null
        diffs = [deriveDiff(input.oldString, input.newString)]
      }
      if (exactInput) {
        previewState = 'exact'
      } else {
        const linePreview = capStreamingDiffs(diffs)
        diffs = linePreview.diffs
        const capped = preview.previewTruncated || linePreview.truncated
        previewState = capped ? 'capped' : 'partial'
        if (capped) sourceInput = raw
      }
    } else if (raw) {
      // Before the path closes, raw JSON is the only useful progress signal.
      // Keep that normal surface bounded too: otherwise moving the cap from the
      // decoder into an unbounded StreamingCodeBlock would merely relocate the
      // same per-delta O(total) work. Exact bytes remain lazy below when cut.
      rawStreamingInput = raw.slice(0, STREAMING_EDIT_HEADER_SCAN_CHARS)
      const capped = preview.previewTruncated || raw.length > rawStreamingInput.length
      previewState = capped ? 'capped' : 'receiving'
      if (capped) sourceInput = raw
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
    previewState,
    sourceInput,
    parsedPatchSource,
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
      // MultiEdit — per-chunk headers only label the chunk. Keep the path on
      // the data object even when headers are hidden: DiffView uses it to pick
      // the lexical grammar and stable JS/TS LSP virtual document. Dropping it
      // here made every Claude edit plaintext despite the header knowing the
      // exact file.
      path: vm.filePath,
      action: null,
      movedTo: null,
      lines,
      chunkLabel: vm.diffs.length > 1 ? `change ${i + 1} / ${vm.diffs.length}` : null,
    }))
  }, [vm.diffs, vm.filePath, vm.patchFiles])

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
          {(() => {
            // Codex-native (+N −M) header totals (diff_render.rs
            // render_line_count_summary): green adds, red removes.
            const all = [...vm.diffs.flat(), ...vm.patchFiles.flatMap(f => f.lines)]
            const added = all.filter(l => l.kind === '+').length
            const removed = all.filter(l => l.kind === '-').length
            if (added === 0 && removed === 0) return null
            return (
              <span className="text-[11px] flex-shrink-0 tabular-nums">
                (<span className="text-diff-add-fg">+{added}</span>{' '}
                <span className="text-diff-remove-fg">−{removed}</span>)
              </span>
            )
          })()}
          <StatusBadge status={vm.status} />
        </div>
        {vm.rawStreamingInput !== null ? (
          <div className="flex flex-col gap-1">
            {/* Transport JSON/JavaScript is not the user's operation. Before a
                path or complete patch header is knowable, keep the stable edit
                row visible with an honest preparation state; raw source remains
                available only through the explicitly debug-labelled disclosure. */}
            <div className="text-muted text-[12px] italic animate-pulse">
              Receiving file change…
            </div>
            <ExpandSection summary="Source input (debug)">
              <StreamingCodeBlock
                code={vm.rawStreamingInput}
                language={toolName === 'apply_patch' ? 'javascript' : 'json'}
                blockKey={`edit-raw:${vm.id}`}
              />
            </ExpandSection>
          </div>
        ) : (
          <DiffView
            files={files}
            showHeaders={vm.patchFiles.length > 0 || vm.diffs.length > 1}
          />
        )}
        {vm.previewState === 'capped' ? (
          <div
            role="status"
            className="rounded border border-warning/40 bg-warning/5 px-2 py-1 text-[11px] leading-[1.5] text-warning"
          >
            Live diff preview paused at its safety limit (
            {STREAMING_EDIT_PREVIEW_RAW_CHARS} encoded edit characters,{' '}
            {STREAMING_EDIT_PREVIEW_LINES} diff lines, or{' '}
            {STREAMING_MULTI_EDIT_PREVIEW_ITEMS} edit chunks). The exact parsed
            change will replace it when valid tool input becomes available.
          </div>
        ) : null}
        {vm.sourceInput ? (
          <ExpandSection summary="Exact source input (debug)">
            {/* The cap is a normal-render CPU/DOM policy, not permission to
                discard provider evidence. This subtree stays unmounted until
                explicitly opened; syntax highlighting is disabled because the
                exact source can be arbitrarily larger than the live preview. */}
            <CodeBlock
              code={vm.sourceInput}
              language="json"
              codeId={`edit-source-input:${vm.id}`}
              highlight={false}
            />
          </ExpandSection>
        ) : null}
        {vm.parsedPatchSource ? (
          <ExpandSection summary="Parsed patch source (debug)">
            {/* The diff is an interpretation of a provider grammar. Keeping the
                exact decoded grammar lazily available makes parser mistakes
                diagnosable and gives the existing Copy Code Block command a
                lossless source, without putting generated wrapper JavaScript in
                the normal operation view. */}
            <CodeBlock
              code={vm.parsedPatchSource}
              language="diff"
              codeId={`edit-patch-source:${vm.id}`}
            />
          </ExpandSection>
        ) : null}
        {vm.resultError ? (
          <OutputWell text={vm.resultError} isError ansi />
        ) : null}
      </div>
    </MarkerRow>
  )
})

// PatchResultCard — the standalone "Edited …" confirmation row for a
// unified-exec-era patch_apply_end event. Its call_id pairs with NO
// tool_use (fresh `exec-<uuid>`; the DiffCard for the same edit renders
// from the SCRIPT's patch text on the exec tool_use), so this event
// paints Codex-native style: `• Edited <path> (+N −M)` with the tinted
// diff when the event carried per-file unified_diffs, or a compact
// per-file list when the binary only sent paths — and a loud
// `✘ Failed to apply patch` + stderr on failure (mirrors codex TUI
// patches.rs). Committed-plane only by nature.
export const PatchResultCard = memo(function PatchResultCard({
  files,
  diffs,
  success,
  stderr,
}: {
  files: string[]
  diffs: Record<string, string>
  success: boolean
  stderr: string
}) {
  const { workspaceRoot } = useContext(CodeRenderContext)
  const diffFiles: DiffViewFile[] = Object.entries(diffs).map(([path, diff]) => ({
    path,
    action: 'update' as const,
    movedTo: null,
    lines: unifiedDiffToLines(diff),
  }))

  if (!success) {
    return (
      <MarkerRow marker="⏺">
        <div className="flex flex-col gap-1">
          <span className="text-danger font-semibold text-[13px] leading-[1.65]">
            ✘ Failed to apply patch
          </span>
          {diffFiles.length > 0 ? <DiffView files={diffFiles} /> : null}
          {stderr ? <OutputWell text={stderr} isError ansi /> : null}
        </div>
      </MarkerRow>
    )
  }

  return (
    <MarkerRow marker="⏺">
      <div className="flex flex-col gap-1">
        <div className="text-[13px] leading-[1.65] flex items-baseline gap-2 min-w-0">
          <span className="text-accent font-semibold flex-shrink-0">Edited</span>
          {files.length === 1 ? (
            <span
              className="text-ink-dim font-code text-[12px] truncate min-w-0"
              style={{ direction: 'rtl', textAlign: 'left' }}
              title={files[0]}
            >
              {formatToolFilePath(files[0], workspaceRoot)}
            </span>
          ) : (
            <span className="text-ink-dim text-[12px] flex-shrink-0">
              {files.length} files
            </span>
          )}
          <StatusBadge status="complete" />
        </div>
        {diffFiles.length > 0 ? (
          <DiffView files={diffFiles} />
        ) : files.length > 1 ? (
          <MarkerRow marker="⎿" tone="muted">
            <div className="font-code text-[12px] leading-[1.55] text-ink-dim">
              {files.map(f => (
                <div key={f} className="break-all" title={f}>
                  {formatToolFilePath(f, workspaceRoot)}
                </div>
              ))}
            </div>
          </MarkerRow>
        ) : null}
      </div>
    </MarkerRow>
  )
})
