import { JsonResultSlab } from '@providers/shared/renderer/rows/JsonResultSlab'
import { JsonToolRow } from '@providers/shared/renderer/rows/JsonToolRow'
import { GenericLiveResult } from '@providers/shared/renderer/rows/GenericLiveResult'
import { memo, useContext, useState } from 'react'

import type { ToolUseBlock } from '@shared/types/transcript'
import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import { boundedJsonPreview } from '@renderer/lib/text/boundedJson'
import {
  exceedsInlineTextBudget,
} from '@renderer/lib/text/boundedText'
import type { SemanticLiveTurn } from '@renderer/session-runtime/state'

import { splitStreamingCodeFence } from '@renderer/features/feed/lib/helpers'
import { observeRenderShape } from '@renderer/features/feed/evidence/observer'
import { useRenderShapeCapture } from '@renderer/features/feed/evidence/RenderShapeCaptureContext'
import {
  absorbedOutcome,
  GENERIC_OUTCOME,
  specializedOutcome,
} from '@renderer/features/feed/evidence/outcome'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { StreamingProse } from '@renderer/features/feed/ui/markdown'
import {
  ProviderContext,
  ToolResultIndexContext,
} from '@renderer/features/feed/context'
function DeferredJsonDetails({
  value,
  blockIndex,
}: {
  value: Record<string, unknown>
  blockIndex: number
}) {
  const [open, setOpen] = useState(false)
  let count = 0
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue
    count += 1
    if (count >= 40) break
  }

  return (
    <details
      className="text-[12px]"
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-ink-dim select-none">
        {count}{count >= 40 ? '+' : ''} param{count === 1 ? '' : 's'}
      </summary>
      {/* WHY projection and CodeBlock only exist while open: live tool input
          changes on every semantic delta. Eager stringify/highlight made each
          growing update repay all prior bytes, and a first-open latch retained
          the completed tree forever. This branch bounds traversal and releases
          the tree the moment the disclosure closes. */}
      {open ? (() => {
        const json = boundedJsonPreview(value)
        return json ? (
          <div className="mt-1">
            <CodeBlock
              code={json}
              language="json"
              codeId={`live-tool-input:${blockIndex}`}
              highlight={false}
            />
          </div>
        ) : null
      })() : null}
    </details>
  )
}

function DeferredThinking({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <details
      className="italic text-muted text-[12px] opacity-80"
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer select-none">
        ∴ Thinking{streaming ? '…' : ''}
        <span className="ml-2 not-italic text-ink-dim opacity-70">
          (click to expand)
        </span>
      </summary>
      {/* WHY a closed reasoning row must not parse Markdown: `<details>` only
          changes paint visibility; React still builds its children. Reasoning
          can be one of the largest streaming strings, so invisibly parsing it
          defeats the point of a collapsed default. */}
      {open ? (
        <div className="mt-2 text-ink-dim opacity-90 not-italic">
          <StreamingProse text={text} />
        </div>
      ) : null}
    </details>
  )
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
  const currentProvider = useContext(ProviderContext)
  const committedToolResults = useContext(ToolResultIndexContext)
  const providerCapabilities = getRendererProviderCapabilities(currentProvider)
  const providerSemanticDecision = providerCapabilities.renderSemanticBlock?.(block, {
    committedToolResults,
  })

  // Observe the provider's actual admission decision, not merely whether a
  // React node happened to be returned. Git-in-exec, ordinary exec, and an
  // empty continuation poll can share the same semantic wire kind while
  // having three different owners. Collapsing those into a provider-wide
  // receipt would make the evidence catalog look healthy while the wrong
  // renderer was painting (or suppressing) the operation.
  const capture = useRenderShapeCapture()
  if (capture) {
    const isThinking = block.kind === 'thinking' || block.kind === 'reasoning'
    const thinkingEmpty = isThinking && !(block.thinking ?? block.text ?? '').trim()
    observeRenderShape({
      sessionId: capture.sessionId,
      provider: capture.provider,
      plane: 'semantic-tool',
      lifecycle: block.finalized ? 'input-complete' : 'prefix',
      eventType: block.kind,
      payload: block,
      outcome: thinkingEmpty
        ? absorbedOutcome('semantic.blockrow', 'empty thinking/reasoning suppressed')
        : providerSemanticDecision?.action === 'render'
          ? specializedOutcome(
              providerSemanticDecision.receipt.rendererId,
              providerSemanticDecision.receipt.protocolId,
            )
          : providerSemanticDecision?.action === 'absorb'
            ? absorbedOutcome(
                providerSemanticDecision.ownerRenderId,
                providerSemanticDecision.reason,
                providerSemanticDecision.protocolId,
              )
            : GENERIC_OUTCOME,
    })
  }
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
        <DeferredThinking text={text} streaming={isStreaming} />
      </MarkerRow>
    )
  }

  if (providerSemanticDecision?.action === 'render') return providerSemanticDecision.node
  if (providerSemanticDecision?.action === 'absorb') return null

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
    if (raw !== undefined && typeof raw !== 'string') {
      return <JsonResultSlab value={raw} isError={false} />
    }
    return <GenericLiveResult source={raw ?? '(no output)'} isError={false} />
  }

  if (
    block.kind === 'function_call' ||
    block.kind === 'custom_tool_call' ||
    block.kind === 'tool_use' ||
    block.kind === 'server_tool_use' ||
    block.kind === 'mcp_tool_use'
  ) {
    const hasResult = block.resultAt != null || block.resultContent != null
    const genericTool: ToolUseBlock = {
      type: 'tool_use',
      id: block.toolUseId ?? block.callId ?? block.itemId ?? `live:${block.blockIndex}`,
      name: block.toolName ?? block.kind,
      // WHY raw partial input remains an object: JsonToolRow can preserve the
      // exact transport fragment behind bounded disclosure without pretending
      // it is valid provider input. Once parsedInput exists it takes over.
      input: block.parsedInput ?? {
        raw: block.argumentsJson ?? block.inputJson ?? '',
      },
    }
    return (
      <div className="flex flex-col gap-2">
        <JsonToolRow block={genericTool} live />
        {block.parseError ? (
          <div className={`ml-6 text-[12px] leading-[1.55] ${toolState?.status === 'error' ? 'text-danger' : 'text-muted'}`}>
            invalid tool input: {block.parseError}
          </div>
        ) : null}
        {hasResult ? (
          <GenericLiveResult
            source={block.resultContent || '(empty result)'}
            isError={block.resultIsError === true}
          />
        ) : null}
      </div>
    )
  }

  const text = block.text ?? ''
  // WHY fence detection shares the prose admission budget: lastIndexOf/slice
  // are linear over the complete live buffer. Oversized streaming text is
  // already handled by the paged raw fallback, so parsing a partial Markdown
  // fence first would reintroduce the unbounded pre-render work.
  const fence = text && !exceedsInlineTextBudget(text)
    ? splitStreamingCodeFence(text)
    : null
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

  if (!text && block.kind !== 'message') {
    // WHY the fallback paints the whole normalized semantic object lazily:
    // upstream can add a new typed item before Agent Code knows its grammar.
    // A name-only row hid exactly the evidence needed to understand those
    // additions; eager JSON would make a giant novel item a render hazard.
    return (
      <MarkerRow marker="⏺" tone="muted">
        <div className="min-w-0">
          <div className="text-[11px] uppercase tracking-wider text-muted">
            {block.kind.replace(/_/g, ' ')}
          </div>
          <DeferredJsonDetails
            value={block as unknown as Record<string, unknown>}
            blockIndex={block.blockIndex}
          />
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
