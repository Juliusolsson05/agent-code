import { memo, useContext, useState } from 'react'

import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import type {
  ContentBlock,
  ToolResultBlock,
  ToolUseBlock,
} from '@shared/types/transcript'
import {
  ProviderContext,
  ToolResultIndexContext,
  ToolUseIndexContext,
} from '@renderer/features/feed/context'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import { TextProse } from '@renderer/features/feed/ui/markdown'

import { ImageBlockRow } from '@renderer/features/feed/ui/rows/ImageBlockRow'
import { UserBand } from '@renderer/features/feed/ui/rows/primitives'
import { ToolResultRow } from '@renderer/features/feed/ui/rows/ToolResultRow'
import { JsonToolRow } from '@providers/shared/renderer/rows/JsonToolRow'
import { CodeBlock } from '@renderer/lib/code/CodeBlock'
import { boundedJsonPreview } from '@renderer/lib/text/boundedJson'
import type { RenderOutcomeRoute, RenderShapePlane } from '@shared/types/renderShapes'
import { observeRenderShape } from '@renderer/features/feed/evidence/observer'
import { useRenderShapeCapture } from '@renderer/features/feed/evidence/RenderShapeCaptureContext'
import {
  absorbedOutcome,
  GENERIC_OUTCOME,
  specializedOutcome,
  unknownOutcome,
} from '@renderer/features/feed/evidence/outcome'

/* ---------- Block dispatcher ---------- */

// Memoized: blocks inside an assistant/user message are stable objects —
// the entry never mutates, so block identity is a perfect memo key.
//
// This is the main per-block dispatcher. ConversationRow hands it a
// ContentBlock and a role, and Block picks the right renderer:
//   - text under role='user' → UserBand + TextProse
//   - text under role='assistant' → TextProse with `⏺` marker
//   - thinking → collapsed <details> if non-empty, else nothing
//   - image → ImageBlockRow
//   - tool_use → provider-specific renderer (Claude: evidence-backed rich
//     rows; Codex: evidence-backed rich rows; everything else:
//     bounded JsonToolRow fallback).
//   - tool_result → the RESULT decision from the exact same correlated
//     provider operation. Central feed code never recognizes a provider tool
//     name and never mirrors an absorption condition.

function UnknownBlockRow({ block }: { block: ContentBlock }) {
  const [open, setOpen] = useState(false)
  return (
    <MarkerRow marker="⏺" tone="muted">
      <details
        className="min-w-0 text-[11px] text-muted"
        onToggle={event => setOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer select-none uppercase tracking-wider">
          Unknown block · {block.type}
        </summary>
        {/* WHY unknown must remain useful on first contact: the catalog inbox
            is a developer aid, but the user still needs a bounded view of the
            new provider payload now. Projection/highlighting happens only on
            demand so a novel giant block cannot freeze every feed repaint. */}
        {open ? (
          <div className="mt-1">
            <CodeBlock
              code={boundedJsonPreview(block) ?? '(unavailable)'}
              language="json"
              highlight={false}
            />
          </div>
        ) : null}
      </details>
    </MarkerRow>
  )
}

export const Block = memo(function Block({
  block,
  role,
}: {
  block: ContentBlock
  role: 'user' | 'assistant'
}) {
  const currentProvider = useContext(ProviderContext)
  const toolUseIndex = useContext(ToolUseIndexContext)
  const toolResultIndex = useContext(ToolResultIndexContext)
  const capture = useRenderShapeCapture()
  // Shape sighting at the exact paint-decision point (Phase 2, PR #555).
  // A module-state side effect during render, on purpose: it never touches
  // React state (no re-render), it is inert unless capture is armed (one
  // Map.get), and StrictMode double-renders only bump a dedup counter — the
  // documented approximate-count contract in observer.ts. Committed blocks
  // are durable transcript evidence, hence lifecycle 'durable'.
  const sight = (plane: RenderShapePlane, payload: unknown, outcome: RenderOutcomeRoute): void => {
    if (!capture) return
    observeRenderShape({
      sessionId: capture.sessionId,
      provider: capture.provider,
      plane,
      lifecycle: 'durable',
      eventType: block.type,
      payload,
      outcome,
    })
  }
  switch (block.type) {
    case 'text': {
      // Only text blocks under a user role represent an actual user
      // prompt. A sibling tool_result block in the same message is
      // NOT a user prompt (it's tool output), and must not get the
      // highlight — that's why the band lives here and not around
      // the whole ConversationRow.
      const row = (
        <MarkerRow marker={role === 'user' ? '❯' : '⏺'}>
          <TextProse text={(block as { text: string }).text} />
        </MarkerRow>
      )
      return role === 'user' ? <UserBand>{row}</UserBand> : row
    }
    case 'thinking': {
      // Persisted thinking block. Anthropic strips the plaintext from
      // the final message (only `signature` ciphertext survives), so
      // text is ALMOST ALWAYS empty in committed transcripts. Old
      // behaviour was to render a placeholder `∴ Thinking` row; now
      // we render nothing and let the WorkIndicator (while live) and
      // the absence of content (after the fact) speak for themselves.
      //
      // Non-empty thinking on a committed block does still exist
      // (older sessions, non-Opus-4 models, synthetic entries). Keep
      // the expandable surface for those — aligned with the live
      // branch above, `<details>` closed by default.
      //
      // See docs/superpowers/plans/2026-04-18-thinking-indicator-rework.md.
      const text = (block as { thinking?: string }).thinking ?? ''
      if (!text) return null
      return (
        <MarkerRow marker="⏺" tone="muted">
          <details className="text-muted text-[12px]">
            <summary className="cursor-pointer select-none italic">
              ∴ Thinking
              <span className="ml-2 not-italic text-ink-dim opacity-70">
                (click to expand)
              </span>
            </summary>
            <div className="mt-1.5 text-ink-dim opacity-80">
              <TextProse text={text} />
            </div>
          </details>
        </MarkerRow>
      )
    }
    case 'image': {
      return <ImageBlockRow block={block} role={role} />
    }
    case 'tool_use': {
      // Dispatch tool_use blocks to provider-specific row renderers. A name is
      // not enough to earn a custom component: families without captured wire
      // evidence deliberately fall through to the bounded generic card.
      const tu = block as ToolUseBlock

      const decision = getRendererProviderCapabilities(currentProvider).renderOperation({
        toolUse: tu,
        result: toolResultIndex.get(tu.id) ?? null,
        live: false,
        streaming: false,
      })
      const route = decision.toolUse
      sight(
        'committed-tool-use',
        tu,
        route.action === 'render'
          ? specializedOutcome(route.receipt.rendererId, route.receipt.protocolId)
          : route.action === 'absorb'
            ? absorbedOutcome(route.ownerRenderId, route.reason, route.protocolId)
          : GENERIC_OUTCOME,
      )
      // Shared fallback is the generic JSON tool row (residue plan P1):
      // it stays concise for headline-only inputs
      // (Bash keeps its 2-line cap) and gives MCP/orchestration payloads
      // a real rendering instead of a bare name over raw JSON.
      return route.action === 'render'
        ? route.node
        : route.action === 'absorb'
          ? null
          : <JsonToolRow block={tu} />
    }
    case 'tool_result': {
      const tr = block as ToolResultBlock
      const sourceTool = toolUseIndex.get(tr.tool_use_id)
      // Orphan results are valid provider drift and stay visible. Without the
      // invocation there is no operation grammar that can justify either a
      // specialized parse or absorption.
      if (!sourceTool) {
        sight('committed-tool-result', tr, GENERIC_OUTCOME)
        return <ToolResultRow block={tr} sourceTool={sourceTool} />
      }
      const decision = getRendererProviderCapabilities(currentProvider).renderOperation({
        toolUse: sourceTool,
        result: tr,
        live: false,
        streaming: false,
      })
      const route = decision.toolResult
      sight(
        'committed-tool-result',
        tr,
        !route || route.action === 'fallback'
          ? GENERIC_OUTCOME
          : route.action === 'absorb'
            ? absorbedOutcome(route.ownerRenderId, route.reason, route.protocolId)
            : specializedOutcome(route.receipt.rendererId, route.receipt.protocolId),
      )
      return route?.action === 'render'
        ? route.node
        : route?.action === 'absorb'
          ? null
        : <ToolResultRow block={tr} sourceTool={sourceTool} />
    }
    default:
      // An unknown committed block kind is exactly the class of shape the
      // capture system exists to catch — record it as an unknown outcome
      // (visible bounded fallback below), never a silent drop. Plane
      // 'transcript-entry' because a non-tool content block is normalized
      // transcript content, not a tool envelope.
      sight('transcript-entry', block, unknownOutcome('shared.block-type-label'))
      return <UnknownBlockRow block={block} />
  }
})
