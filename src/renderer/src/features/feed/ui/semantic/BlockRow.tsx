import { memo } from 'react'

import {
  CodexApplyPatchRow,
  CodexExecCommandRow,
  CodexToolRow,
  CodexWriteStdinRow,
} from '@providers/codex/renderer/rows/CodexRows'
import type { ToolUseBlock } from '@shared/types/transcript'
import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import {
  parseSemanticTodos,
  type SemanticLiveTurn,
} from '@renderer/workspace/workspaceState'

import { splitStreamingCodeFence } from '@renderer/features/feed/lib/helpers'
import { extractStreamingWriteInput } from '@renderer/features/feed/lib/streamingWriteInput'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { StreamingProse } from '@renderer/features/feed/ui/markdown'

import { SemanticTodoList } from '@renderer/features/feed/ui/semantic/TodoList'

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
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
    if (liveTool.name === 'exec_command') {
      return <CodexExecCommandRow block={liveTool} />
    }
    if (liveTool.name === 'write_stdin') {
      return <CodexWriteStdinRow block={liveTool} />
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
          : JSON.stringify(raw, null, 2)
    return (
      <MarkerRow marker="⎿" tone="muted">
        <pre className="font-code text-[12px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-words m-0 max-h-[360px] overflow-auto">
          {outputText}
        </pre>
      </MarkerRow>
    )
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
    const shell = block.localShellCall
    const command = shell?.command.join(' ') ?? '(no command)'
    return (
      <MarkerRow marker="⏺">
        <div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-[1.65]">
            <span className="text-accent font-semibold">$ Shell</span>
            <span className="text-muted text-[11px] uppercase tracking-wider">
              {shell?.status ?? block.status ?? 'running'}
            </span>
          </div>
          <MarkerRow marker="⎿" tone="muted">
            <pre className="font-code text-[12px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-all m-0">
              {command}
            </pre>
          </MarkerRow>
        </div>
      </MarkerRow>
    )
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
            <MarkerRow marker="⎿" tone="muted">
              <pre
                className={`
                  font-code text-[12px] leading-[1.55] whitespace-pre-wrap break-words m-0
                  max-h-[360px] overflow-auto
                  ${block.resultIsError ? 'text-danger' : 'text-ink-dim'}
                `}
              >
                {block.resultContent || '(empty result)'}
              </pre>
            </MarkerRow>
          ) : null}
        </div>
      </MarkerRow>
    )
  }

  const text = block.text ?? ''
  const fence = text ? splitStreamingCodeFence(text) : null
  if (fence) {
    return (
      <MarkerRow marker="⏺">
        <div className="flex flex-col gap-2">
          {fence.prose ? <StreamingProse text={fence.prose} /> : null}
          <CodeBlock
            code={fence.code}
            language={fence.language}
            codeId={`live:${block.blockIndex}:${fence.language ?? 'plain'}`}
            engine="monaco"
            allowAutoDetect={!fence.language}
          />
        </div>
      </MarkerRow>
    )
  }

  if (block.citations && block.citations.length > 0) {
    return (
      <MarkerRow marker="⏺">
        <div className="flex flex-col gap-2">
          {text ? <StreamingProse text={text} /> : null}
          <div className="text-muted text-[11px] uppercase tracking-wider">
            {block.citations.length} citation{block.citations.length === 1 ? '' : 's'}
          </div>
        </div>
      </MarkerRow>
    )
  }

  return (
    <MarkerRow marker="⏺">
      <StreamingProse text={text} />
    </MarkerRow>
  )
})
