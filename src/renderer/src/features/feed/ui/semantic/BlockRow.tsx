import { memo } from 'react'

import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import {
  parseSemanticTodos,
  type SemanticLiveTurn,
} from '@renderer/workspace/workspaceState'

import { splitStreamingCodeFence } from '@renderer/features/feed/lib/helpers'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { StreamingProse } from '@renderer/features/feed/ui/markdown'

import { SemanticTodoList } from '@renderer/features/feed/ui/semantic/TodoList'

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
    const label = block.toolName ?? block.kind
    const argsText =
      block.argumentsJson ?? block.inputJson ?? '(no arguments yet)'
    const statusBadge = block.status
      ? block.status.replace(/_/g, ' ')
      : block.finalized
        ? 'done'
        : 'running'
    return (
      <MarkerRow marker="⏺">
        <div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] leading-[1.65]">
            <span className="text-accent font-semibold">{label}</span>
            <span className="text-muted text-[11px] uppercase tracking-wider">
              {statusBadge}
            </span>
          </div>
          <MarkerRow marker="⎿" tone="muted">
            <pre className="font-code text-[12px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-all m-0">
              {argsText || '(waiting for input…)'}
            </pre>
          </MarkerRow>
          {block.parseError ? (
            <MarkerRow marker="⎿" tone="muted">
              <div className="text-danger text-[12px] leading-[1.55]">
                invalid tool input: {block.parseError}
              </div>
            </MarkerRow>
          ) : null}
        </div>
      </MarkerRow>
    )
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
