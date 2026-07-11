import { JsonResultSlab } from '@providers/shared/renderer/rows/JsonResultSlab'
import { JsonToolRow, SLAB_MAX_CHARS } from '@providers/shared/renderer/rows/JsonToolRow'
import { tryExtractJson } from '@providers/shared/renderer/rows/jsonToolPresentation'
import { memo } from 'react'

import {
  CodexApplyPatchRow,
  CodexToolRow,
} from '@providers/codex/renderer/rows/CodexRows'
import {
  EditRow,
  MultiEditRow,
} from '@providers/claude/renderer/rows/ClaudeRows'
import type { ToolUseBlock } from '@shared/types/transcript'
import { parseJsonRecord } from '@shared/lib/asRecord'
import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import {
  parseSemanticTodos,
  type SemanticLiveTurn,
} from '@renderer/session-runtime/state'

import { extractStreamingWriteInput } from '@renderer/features/feed/lib/streamingWriteInput'
import { CommandCard } from '@renderer/features/feed/ui/artifacts/command'
import { commandFromLive } from '@renderer/features/feed/ui/resolve/fromLive'
import { OutputWell } from '@renderer/features/feed/ui/kit/OutputWell'
import { SegmentedMarkdown } from '@renderer/features/feed/ui/kit/SegmentedMarkdown'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { StreamingProse } from '@renderer/features/feed/ui/markdown'

import { AskUserQuestionRow } from '@renderer/features/feed/ui/semantic/AskUserQuestionRow'
import { SemanticTodoList } from '@renderer/features/feed/ui/semantic/TodoList'

// [#285] Extract a CLOSED top-level JSON string field from a partial inputJson
// buffer — i.e. one whose closing quote has already streamed. The regex body
// `(?:[^"\\]|\\.)*` tolerates escaped quotes and embedded newlines, so it only
// matches a fully-arrived value. Used ONLY during the brief streaming window
// before the whole object is JSON-parseable; the moment `parseJsonRecord`
// succeeds (below) the authoritative parse takes over. A value that literally
// contains the key text mid-stream could mis-match transiently, but it
// self-corrects on the next delta / final parse — strictly better than the raw
// JSON blob this replaces.
function extractClosedJsonString(raw: string, key: string): string | null {
  const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
  const m = re.exec(raw)
  if (!m) return null
  try {
    return JSON.parse(`"${m[1]}"`) as string
  } catch {
    return null
  }
}

// Cap any pretty-printed JSON slab on the LIVE path the same way JsonToolRow
// caps its committed slabs. WHY: these two call sites stringify tool output /
// parsed input straight into the DOM every render while the block streams. An
// unbounded payload (a whole-file read result, a giant orchestration graph) is
// the O(bytes²) highlight/paint trap on the hottest path in the feed. We reuse
// JsonToolRow's exported SLAB_MAX_CHARS instead of a fresh magic number so the
// live and committed previews truncate identically (they used to only be
// capped on the committed side, so a live row could balloon).
function cappedJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2)
  return json.length > SLAB_MAX_CHARS ? `${json.slice(0, SLAB_MAX_CHARS)}\n…` : json
}

// [#285] Build the committed Edit/MultiEdit input object from a live semantic
// block, so the streaming path can render the SAME rich EditRow/MultiEditRow
// (FileToolHeader + line-level DiffSlab) the committed transcript uses —
// mirroring how Codex reuses its committed rows on the live path (see the
// function_call branch below). Returns null until at least `file_path` has
// streamed so we never flash an empty "Edit · (no changes)" card; the caller
// then falls through to the raw preview until the path arrives.
function claudeLiveEditInput(
  block: SemanticLiveTurn['blocks'][number],
): Record<string, unknown> | null {
  if (block.parsedInput) return block.parsedInput
  const raw = block.inputJson ?? ''
  const full = raw ? parseJsonRecord(raw) : null
  if (full) return full
  if (!raw) return null
  const filePath = extractClosedJsonString(raw, 'file_path')
  if (!filePath) return null
  if (block.toolName === 'MultiEdit') {
    // The `edits` array can't be reliably half-parsed; show the header now
    // (file path) and let the authoritative parse above fill in the per-edit
    // diff chunks the instant the whole object completes.
    return { file_path: filePath, edits: [] }
  }
  return {
    file_path: filePath,
    old_string: extractClosedJsonString(raw, 'old_string') ?? '',
    new_string: extractClosedJsonString(raw, 'new_string') ?? '',
  }
}

const SIMPLE_JSON_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
}

function decodePartialJsonStringBody(raw: string, start: number): string {
  let out = ''
  let i = start
  while (i < raw.length) {
    const ch = raw[i]
    if (ch === '"') return out
    if (ch === '\\') {
      if (i + 1 >= raw.length) return out
      const esc = raw[i + 1]
      if (esc === 'u') {
        const hex = raw.slice(i + 2, i + 6)
        if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) return out
        out += String.fromCharCode(parseInt(hex, 16))
        i += 6
        continue
      }
      out += SIMPLE_JSON_ESCAPES[esc] ?? esc
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

function extractPartialJsonStringMember(raw: string, keys: string[]): string | null {
  for (const key of keys) {
    const marker = `"${key}"`
    const keyAt = raw.indexOf(marker)
    if (keyAt === -1) continue
    const colonAt = raw.indexOf(':', keyAt + marker.length)
    if (colonAt === -1) continue
    let valueAt = colonAt + 1
    while (valueAt < raw.length && /\s/.test(raw[valueAt] ?? '')) valueAt += 1
    if (raw[valueAt] !== '"') continue
    return decodePartialJsonStringBody(raw, valueAt + 1)
  }
  return null
}

function partialApplyPatchInput(raw: string): Record<string, unknown> {
  if (raw.includes('*** Begin Patch')) return { raw }
  const patch = extractPartialJsonStringMember(raw, [
    'cmd',
    'patch',
    'input',
    'raw',
    'arguments',
  ])
  return patch && patch.includes('*** Begin Patch') ? { raw: patch } : { raw, arguments: raw }
}

function codexLiveToolInput(block: SemanticLiveTurn['blocks'][number]): unknown {
  const raw = block.argumentsJson ?? block.inputJson ?? ''
  if (block.parsedInput) return block.parsedInput
  const parsed = raw ? parseJsonRecord(raw) : null
  if (parsed) return parsed

  // WHY apply_patch keeps a raw fallback:
  // Codex can surface patch application as a custom/freeform tool
  // call where the payload is the patch grammar itself, not a JSON
  // object. The committed Codex renderer already knows how to parse
  // `{ raw: "*** Begin Patch..." }`; feeding the live block through
  // the same shape gives streaming patch calls the same file/diff
  // card as committed transcript rows instead of showing a giant raw
  // preformatted argument blob.
  if (block.toolName === 'apply_patch' && raw) return partialApplyPatchInput(raw)

  return raw ? { raw, arguments: raw } : {}
}

function codexLiveToolUseBlock(block: SemanticLiveTurn['blocks'][number]): ToolUseBlock {
  return {
    type: 'tool_use',
    id: block.callId ?? block.toolUseId ?? block.itemId ?? `live:${block.blockIndex}`,
    name: block.toolName ?? block.kind,
    input: codexLiveToolInput(block),
  }
}

// Single live-block renderer — this is the big dispatch for the
// semantic streaming path. Each SemanticLiveTurn block is one of a
// dozen kinds (thinking, function_call, tool_use, web_search_call,
// etc.), and this component picks the right tiny presentational
// shape for whichever kind it received.
//
// The branches roughly mirror Codex's upstream event taxonomy but
// stay intentionally minimal: the goal of the live view is to show
// that SOMETHING is happening and WHAT it is — the fuller, final
// version of each turn comes from the committed transcript entries
// rendered by the regular feed row path. Live rows fill the "right
// now" gap without trying to reinvent the finished transcript card.
export const SemanticLiveBlockRow = memo(function SemanticLiveBlockRow({
  block,
  toolState,
}: {
  block: SemanticLiveTurn['blocks'][number]
  toolState: SemanticLiveTurn['lookups']['toolCallsById'][string] | null
}) {
  if (block.kind === 'thinking' || block.kind === 'reasoning') {
    // Live thinking — for Claude this is the ONLY time the plaintext is
    // available (`thinking` is stripped on the final message before
    // persisting; only signature ciphertext survives). For Codex the
    // `reasoning` block works similarly, and plaintext is frequently
    // empty because ChatGPT delivers reasoning encrypted.
    //
    // Design (2026-04-18 rework):
    //   - Empty thinking → render NOTHING. The WorkIndicator at the
    //     foot of the feed already shows "Thinking · Ns" with a
    //     pulsing dot, so the old static `∴ Thinking…` row was
    //     redundant noise that actively looked "hung" when encrypted.
    //   - Non-empty thinking → collapsed `<details>` (closed by
    //     default). Users who want to read reasoning click to expand;
    //     nobody sees a flood of italic prose they didn't ask for.
    //
    // See docs/superpowers/plans/2026-04-18-thinking-indicator-rework.md.
    const text =
      block.thinking ||
      block.reasoningSummary ||
      block.reasoningText ||
      ''
    if (!text) return null
    const isStreaming = !block.finalized
    return (
      <MarkerRow marker="⏺" tone="muted">
        <details className="italic text-muted text-[12px] opacity-80">
          <summary className="cursor-pointer select-none">
            ∴ Thinking{isStreaming ? '…' : ''}
            <span className="ml-2 not-italic text-ink-dim opacity-70">
              (click to expand)
            </span>
          </summary>
          <div className="mt-2 text-ink-dim opacity-90 not-italic">
            <StreamingProse text={text} />
          </div>
        </details>
      </MarkerRow>
    )
  }

  // Codex-specific variants — minimal first-class rendering so tool
  // calls, searches, shell commands, and image generations show up
  // live from the proxy stream instead of waiting for rollout to
  // catch up. Each variant shows what it IS (tool name / command /
  // query / status) without trying to reinvent the full rollout-
  // rendered card; rollout's reducer writes the canonical final
  // version to the feed, and these live rows fill in the "right now"
  // gap. Ordered from highest-frequency (function_call) to lowest.

  if (block.kind === 'function_call' || block.kind === 'custom_tool_call') {
    const liveTool = codexLiveToolUseBlock(block)

    // WHY live Codex calls reuse committed Codex row renderers:
    // The broken 18:54 transcript showed the live plane rendering
    // provider internals (`exec_command`, `write_stdin`, raw JSON)
    // while the committed plane had richer cards for the same work.
    // That split is exactly how streaming and final rendering drift
    // apart. Convert the live semantic block into the same
    // ToolUseBlock shape the committed transcript uses, then delegate
    // to the committed Codex card. Streaming now means "same card
    // with partial input" instead of a separate raw-JSON UI.
    if (liveTool.name === 'apply_patch') {
      return <CodexApplyPatchRow block={liveTool} />
    }
    // Command family — the SAME CommandCard the committed plane renders
    // (spec §6 convergence). Live output streams into the card as
    // tool_output_delta accumulates on the block; exit tint arrives via
    // resultIsError on tool_completed.
    if (liveTool.name === 'exec_command' || liveTool.name === 'write_stdin') {
      return <CommandCard vm={commandFromLive(block, toolState, 'codex')} />
    }
    // Parse-gated convergence with the committed fallback (residue plan
    // P1): a fully-parsed live payload renders through the same shared
    // JsonToolRow the committed row will use; raw/partial payloads keep
    // CodexToolRow's degraded look until the JSON completes. THIN glue on
    // purpose — this whole bypass dies at Stage 3.
    const liveInput = liveTool.input as Record<string, unknown> | null
    if (liveInput && !('raw' in liveInput)) {
      return <JsonToolRow block={liveTool} live />
    }
    return <CodexToolRow block={liveTool} />
  }

  if (
    block.kind === 'function_call_output' ||
    block.kind === 'custom_tool_call_output' ||
    block.kind === 'tool_search_output'
  ) {
    // Output blocks land as separate output_items on the SSE wire
    // (the function_call emits one item, the function_call_output
    // emits another — paired only by call_id). Render as a
    // standalone output row; downstream Feed rendering can associate
    // it with the call via the shared callId if the renderer wants to.
    const raw = block.output
    const outputText =
      typeof raw === 'string'
        ? raw
        : raw === undefined
          ? '(no output)'
          : cappedJson(raw)
    // OutputWell so live function output matches the committed result
    // surface — ANSI-aware, collapsed to 3 lines, loud truncation.
    return <OutputWell text={outputText} isError={false} ansi />
  }

  if (block.kind === 'web_search_call') {
    const action = block.webSearchAction
    const label =
      action?.kind === 'search'
        ? `Search: ${action.query ?? action.queries?.join(', ') ?? '…'}`
        : action?.kind === 'open_page'
          ? `Open: ${action.url ?? '?'}`
          : action?.kind === 'find_in_page'
            ? `Find "${action.pattern ?? '?'}" in ${action.url ?? '?'}`
            : 'Web search'
    return (
      <MarkerRow marker="⏺">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-[1.65]">
          <span className="text-accent font-semibold">🌐 {label}</span>
          {block.status ? (
            <span className="text-muted text-[11px] uppercase tracking-wider">
              {block.status.replace(/_/g, ' ')}
            </span>
          ) : null}
        </div>
      </MarkerRow>
    )
  }

  if (block.kind === 'image_generation_call') {
    const img = block.imageGeneration
    return (
      <MarkerRow marker="⏺">
        <div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-[1.65]">
            <span className="text-accent font-semibold">🖼 Image generation</span>
            <span className="text-muted text-[11px] uppercase tracking-wider">
              {img?.status ?? block.status ?? 'running'}
            </span>
          </div>
          {img?.revisedPrompt ? (
            <MarkerRow marker="⎿" tone="muted">
              <div className="text-ink-dim text-[12px] leading-[1.55] italic">
                {img.revisedPrompt}
              </div>
            </MarkerRow>
          ) : null}
        </div>
      </MarkerRow>
    )
  }

  if (block.kind === 'local_shell_call') {
    // Same CommandCard as committed local_shell rows — the bespoke
    // "$ Shell" chip this replaces was live-only and drifted from the
    // committed rendering (audit gap #3).
    return <CommandCard vm={commandFromLive(block, toolState, 'codex')} />
  }

  if (block.kind === 'tool_search_call') {
    const label = block.toolName ?? 'Tool search'
    return (
      <MarkerRow marker="⏺">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-[1.65]">
          <span className="text-accent font-semibold">🔎 {label}</span>
          {block.status ? (
            <span className="text-muted text-[11px] uppercase tracking-wider">
              {block.status.replace(/_/g, ' ')}
            </span>
          ) : null}
        </div>
      </MarkerRow>
    )
  }

  // AskUserQuestion gets a dedicated native picker BEFORE the generic
  // tool_use handler. An unresolved AskUserQuestion block (`!resultAt`)
  // is a LIVE picker blocking the agent on user input; rendering it as
  // the usual "AskUserQuestion · running" tool row (with a raw-JSON
  // input dump) left the user no way to answer except via the terminal.
  // The guard mirrors BlockRow's route-in condition exactly: once the
  // tool_result lands and sets `resultAt`, we fall through to the normal
  // tool_use branch so the answered question renders as a plain
  // committed-style row instead of a stale clickable picker.
  if (block.toolName === 'AskUserQuestion' && !block.resultAt) {
    return <AskUserQuestionRow block={block} />
  }

  if (
    block.kind === 'tool_use' ||
    block.kind === 'server_tool_use' ||
    block.kind === 'mcp_tool_use'
  ) {
    // WHY keep tool results nested under the tool row:
    //
    // Claude's transcript wire format splits tool_use and tool_result
    // across assistant/user turns, but from a reading standpoint they
    // are one unit of work. Nesting the result here preserves that
    // mental model during live streaming and avoids another round of
    // "find the matching tool later in the feed" bookkeeping.
    // [#285] Live Edit / MultiEdit reuse the COMMITTED renderers (rich
    // FileToolHeader + line-level DiffSlab) instead of dumping raw JSON — the
    // exact convergence Codex already does in the function_call branch above.
    // We return the committed row directly (no live wrapper / status badge) so
    // the streaming card is visually identical to its committed form, and the
    // diff fills in as old_string/new_string stream. Until `file_path` has
    // arrived, claudeLiveEditInput returns null and we fall through to the
    // existing raw preview — never worse than before.
    if (block.toolName === 'Edit' || block.toolName === 'MultiEdit') {
      const liveEditInput = claudeLiveEditInput(block)
      if (liveEditInput) {
        const liveBlock: ToolUseBlock = {
          type: 'tool_use',
          id:
            block.toolUseId ??
            block.callId ??
            block.itemId ??
            `live:${block.blockIndex}`,
          name: block.toolName,
          input: liveEditInput,
        }
        return block.toolName === 'Edit' ? (
          <EditRow block={liveBlock} />
        ) : (
          <MultiEditRow block={liveBlock} />
        )
      }
    }

    // Claude live Bash — same CommandCard as its committed row. The
    // command string appears once its JSON literal closes (partial
    // buffers keep the streaming placeholder); the git-intent widget is
    // a committed-plane concern (detectGitIntent needs the full
    // command; by the time a git card matters the committed row owns it).
    if (block.toolName === 'Bash') {
      return <CommandCard vm={commandFromLive(block, toolState, 'claude')} />
    }

    const todos =
      block.toolName === 'TodoWrite'
        ? parseSemanticTodos(block.parsedInput)
        : []
    const hasResult = block.resultAt != null || block.resultContent != null

    // Live `Write` preview. While a Write tool_use streams, the only
    // data we have is `block.inputJson` — partial, unparseable JSON.
    // Dumping it raw means the user watches a 200-line file scroll by
    // as one escaped JSON blob (`{"file_path":"…","content":"# …\n\n…`).
    // `extractStreamingWriteInput` does a single linear scan of that
    // buffer and pulls out the path + the in-flight content, decoded.
    // When it yields a filePath we render the path + a plain code
    // preview of the content as it arrives.
    //
    // This is a LIVE preview, deliberately NOT pixel-identical to the
    // committed WriteRow that replaces it once the block finalizes:
    //   - the committed row uses `FileToolHeader` with a line count;
    //     the live row shows just the path on a `⎿` marker line.
    //   - the live preview passes `highlight={false}` (see below);
    //     the committed row is syntax-highlighted.
    // So there IS a one-time visual change at the commit boundary —
    // the header gains a line count and the code gains highlighting.
    // The content text is identical across the transition; the goal
    // here is "show the file taking shape", not a frozen final card.
    //
    // If the buffer doesn't match Write's expected shape the
    // extractor returns nulls and we fall through to the raw <pre> —
    // never worse than the pre-feature behaviour.
    const writeStream =
      block.toolName === 'Write'
        ? extractStreamingWriteInput(block.inputJson ?? '')
        : null
    return (
      <MarkerRow marker="⏺">
        <div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-[1.65]">
            <span className="text-accent font-semibold">
              {block.toolName ?? block.kind}
            </span>
            {toolState ? (
              <span
                className={
                  toolState.status === 'error'
                    ? 'text-danger text-[11px] uppercase tracking-wider'
                    : 'text-muted text-[11px] uppercase tracking-wider'
                }
              >
                {toolState.status === 'in_progress'
                  ? 'running'
                  : toolState.status === 'error'
                    ? 'failed'
                    : 'done'}
              </span>
            ) : null}
          </div>
          {block.toolName === 'TodoWrite' ? (
            <SemanticTodoList todos={todos} />
          ) : writeStream && writeStream.filePath ? (
            <div className="mt-1 flex flex-col gap-1">
              <MarkerRow marker="⎿" tone="muted">
                <span className="font-code text-[12px] leading-[1.55] text-ink-dim break-all">
                  {writeStream.filePath}
                </span>
              </MarkerRow>
              {/*
                `highlight={false}` is load-bearing for performance.
                highlight.js re-highlights the WHOLE code string on
                every change; this CodeBlock is fed a growing buffer
                that re-renders on every `input_json_delta`, so
                highlighting here would cost O(streamed bytes²) over
                a long write. The plain preview is cheap; the
                committed WriteRow does the one-shot highlight after
                the stream ends. `codeId` is keyed by blockIndex so
                the component stays mounted across the many delta
                re-renders rather than remounting.
              */}
              <CodeBlock
                code={writeStream.partialContent ?? ''}
                path={writeStream.filePath}
                codeId={`write-live:${block.blockIndex}`}
                highlight={false}
              />
            </div>
          ) : block.parsedInput && block.inputJsonValid !== false ? (
            // Parse-gated pretty params (residue plan P1). Partial JSON
            // keeps the raw stream below — pretty-printing half a JSON
            // string is worse than showing it verbatim.
            <MarkerRow marker="⎿" tone="muted">
              <details className="text-[12px]">
                <summary className="cursor-pointer text-ink-dim select-none">
                  {Object.keys(block.parsedInput).length} param
                  {Object.keys(block.parsedInput).length === 1 ? '' : 's'}
                </summary>
                <div className="mt-1">
                  <CodeBlock
                    code={cappedJson(block.parsedInput)}
                    language="json"
                    codeId={`live-tool-input:${block.blockIndex}`}
                    highlight={false}
                  />
                </div>
              </details>
            </MarkerRow>
          ) : (
            <MarkerRow marker="⎿" tone="muted">
              <pre className="font-code text-[12px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-all m-0">
                {block.inputJson || '(waiting for input…)'}
              </pre>
            </MarkerRow>
          )}
          {block.parseError ? (
            <MarkerRow marker="⎿" tone="muted">
              <div className="text-danger text-[12px] leading-[1.55]">
                invalid tool input: {block.parseError}
              </div>
            </MarkerRow>
          ) : null}
          {hasResult ? (
            (() => {
              const parsed = block.resultContent ? tryExtractJson(block.resultContent) : null
              if (parsed !== null && typeof parsed === 'object') {
                return <JsonResultSlab value={parsed} isError={block.resultIsError === true} />
              }
              return (
                <OutputWell
                  text={block.resultContent || '(empty result)'}
                  isError={block.resultIsError === true}
                  ansi
                />
              )
            })()
          ) : null}
        </div>
      </MarkerRow>
    )
  }

  // Streaming assistant text — prose AND code fences, open or closed.
  // SegmentedMarkdown owns the whole surface: the sealed prefix (through
  // the last CLOSED fence) parses once, the tail streams cheaply, and an
  // open fence in the tail paints highlighted line-by-line through
  // StreamingCodeBlock (which replaced the per-delta Monaco remount that
  // used to live right here — see kit/StreamingCodeBlock.tsx for the
  // full history). The old whole-message StreamingProse call re-parsed
  // the entire markdown AST on every delta: O(len²) per message.
  const text = block.text ?? ''

  if (block.citations && block.citations.length > 0) {
    return (
      <MarkerRow marker="⏺">
        <div className="flex flex-col gap-2">
          {text ? (
            <SegmentedMarkdown text={text} blockKey={`live-text:${block.blockIndex}`} />
          ) : null}
          <div className="text-muted text-[11px] uppercase tracking-wider">
            {block.citations.length} citation{block.citations.length === 1 ? '' : 's'}
          </div>
        </div>
      </MarkerRow>
    )
  }

  return (
    <MarkerRow marker="⏺">
      <SegmentedMarkdown text={text} blockKey={`live-text:${block.blockIndex}`} />
    </MarkerRow>
  )
})
