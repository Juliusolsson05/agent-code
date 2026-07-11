import { SLAB_MAX_CHARS } from '@providers/shared/renderer/rows/JsonToolRow'
import { memo } from 'react'

import type { ToolUseBlock } from '@shared/types/transcript'
import { parseJsonRecord } from '@shared/lib/asRecord'
import type { SemanticLiveTurn } from '@renderer/session-runtime/state'

import { CommandCard } from '@renderer/features/feed/ui/artifacts/command'
import {
  DiffCard,
  fileEditFromLive,
} from '@renderer/features/feed/ui/artifacts/fileEdit'
import {
  ReadCard,
  readFromLive,
} from '@renderer/features/feed/ui/artifacts/fileRead'
import {
  FileWriteCard,
  fileWriteFromLive,
} from '@renderer/features/feed/ui/artifacts/fileWrite'
import { GenericToolCard } from '@renderer/features/feed/ui/artifacts/generic'
import {
  commandFromLive,
  genericFromLive,
} from '@renderer/features/feed/ui/resolve/fromLive'
import { OutputWell } from '@renderer/features/feed/ui/kit/OutputWell'
import { SegmentedMarkdown } from '@renderer/features/feed/ui/kit/SegmentedMarkdown'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { StreamingProse } from '@renderer/features/feed/ui/markdown'

import { TodoCard, todoFromLive } from '@renderer/features/feed/ui/artifacts/todo'

import { AskUserQuestionRow } from '@renderer/features/feed/ui/semantic/AskUserQuestionRow'

// Cap any pretty-printed JSON slab on the LIVE path the same way JsonToolRow
// caps its committed slabs — the live and committed previews must truncate
// identically (they used to drift; see SLAB_MAX_CHARS' rationale).
function cappedJson(value: unknown): string {
  const json = JSON.stringify(value, null, 2)
  return json.length > SLAB_MAX_CHARS ? `${json.slice(0, SLAB_MAX_CHARS)}\n…` : json
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

    // WHY live Codex calls reuse committed Codex row renderers:
    // The broken 18:54 transcript showed the live plane rendering
    // provider internals (`exec_command`, `write_stdin`, raw JSON)
    // while the committed plane had richer cards for the same work.
    // That split is exactly how streaming and final rendering drift
    // apart. Convert the live semantic block into the same
    // ToolUseBlock shape the committed transcript uses, then delegate
    // to the committed Codex card. Streaming now means "same card
    // with partial input" instead of a separate raw-JSON UI.
    if (block.toolName === 'apply_patch') {
      return (
        <DiffCard
          vm={fileEditFromLive(block, toolState, 'codex')}
          toolName="apply_patch"
        />
      )
    }
    // Command family — the SAME CommandCard the committed plane renders
    // (spec §6 convergence). Live output streams into the card as
    // tool_output_delta accumulates on the block; exit tint arrives via
    // resultIsError on tool_completed.
    if (block.toolName === 'exec_command' || block.toolName === 'write_stdin') {
      return <CommandCard vm={commandFromLive(block, toolState, 'codex')} />
    }
    // Everything else — the SAME GenericToolCard the committed plane
    // renders (spec §6). Partial JSON streams as growing highlighted
    // params inside the card; the structured slab takes over on parse.
    return <GenericToolCard vm={genericFromLive(block, toolState, 'codex')} />
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
    // Live Edit / MultiEdit — the SAME DiffCard the committed plane
    // renders ([#285] convergence, now VM-driven). The path shows the
    // moment its JSON literal closes; the diff fills in as old/new
    // stream; until the path arrives the raw input streams in the card
    // body — never worse than before.
    if (block.toolName === 'Edit' || block.toolName === 'MultiEdit') {
      return (
        <DiffCard
          vm={fileEditFromLive(block, toolState, 'claude')}
          toolName={block.toolName}
        />
      )
    }

    // Claude live Bash — same CommandCard as its committed row. The
    // command string appears once its JSON literal closes (partial
    // buffers keep the streaming placeholder); the git-intent widget is
    // a committed-plane concern (detectGitIntent needs the full
    // command; by the time a git card matters the committed row owns it).
    if (block.toolName === 'Bash') {
      return <CommandCard vm={commandFromLive(block, toolState, 'claude')} />
    }

    if (block.toolName === 'TodoWrite') {
      return <TodoCard vm={todoFromLive(block, toolState, 'claude')} />
    }
    // Live Read/Grep/Glob/LS with real output — the same ReadCard as
    // committed. (Most live lookups collapse into the churn receipt via
    // groupSemanticActivity; only finished-with-output ones reach here.)
    if (
      block.toolName === 'Read' ||
      block.toolName === 'FileRead' ||
      block.toolName === 'Grep' ||
      block.toolName === 'Glob' ||
      block.toolName === 'LS'
    ) {
      return <ReadCard vm={readFromLive(block, toolState, 'claude')} />
    }

    // Everything else — the SAME GenericToolCard the committed plane
    // renders. This replaces the hand-rolled live card that dumped raw
    // partial inputJson into a <pre> (audit finding 7).
    return <GenericToolCard vm={genericFromLive(block, toolState, 'claude')} />
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
