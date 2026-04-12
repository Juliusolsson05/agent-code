// Codex-specific feed row renderers.
//
// Counterpart to claude/ClaudeRows.tsx. For now this is a minimal
// stub — codex entries render their text content through the shared
// TextProse/MarkerRow primitives. As we capture real codex recordings
// and learn the exact entry shapes for codex's tool calls
// (function_call, function_call_output, etc.), these will grow into
// rich renderers the same way Claude's EditRow/DiffSlab did.
//
// Lives under feed/codex/ so codex-specific rendering logic never
// mixes with claude's.

import { memo } from 'react'

import type { ToolUseBlock } from '../../../../core/types/transcript'
import { MarkerRow } from '../Feed'

/**
 * Generic codex tool-use row. Renders the tool name + a preview of
 * the input as a compact JSON snippet. Will be split into per-tool
 * rich renderers once we know codex's tool call shapes from real
 * recordings.
 */
export const CodexToolRow = memo(function CodexToolRow({
  block,
}: {
  block: ToolUseBlock
}) {
  const input = block.input as Record<string, unknown> | undefined
  // Pull a useful headline: codex function_calls have `name` +
  // `arguments`; generic tool_use has `command` or `description`.
  const headline =
    typeof input?.command === 'string'
      ? input.command
      : typeof input?.arguments === 'string'
        ? input.arguments.slice(0, 120)
        : typeof input?.description === 'string'
          ? input.description
          : null

  return (
    <MarkerRow marker="▌">
      <div>
        <div className="text-[13px] leading-[1.65]">
          <span className="text-accent font-semibold">{block.name}</span>
        </div>
        {headline && (
          <MarkerRow marker="⎿" tone="muted">
            <pre className="font-code text-[12px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-all m-0">
              {headline}
            </pre>
          </MarkerRow>
        )}
      </div>
    </MarkerRow>
  )
})
