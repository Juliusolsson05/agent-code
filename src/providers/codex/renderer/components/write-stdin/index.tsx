// Codex `write_stdin` component (dir-per-component convention, PR #555 —
// see providers/claude/renderer/components/edit/index.tsx for the rule).

import { memo } from 'react'

import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'
import type { ToolUseBlock } from '@shared/types/transcript'
import { asRecord } from '@shared/lib/asRecord'
import { truncateCommand } from '@providers/codex/renderer/adapters/command'

export const CodexWriteStdinRow = memo(function CodexWriteStdinRow({
  block,
}: {
  block: ToolUseBlock
}) {
  const input = asRecord(block.input)
  const chars = typeof input?.chars === 'string' ? input.chars : ''

  return (
    <MarkerRow marker="⏺">
      <div>
        <div className="text-[13px] leading-[1.65]">
          <span className="text-accent font-semibold">stdin</span>
        </div>
        <MarkerRow marker="⎿" tone="muted">
          <pre className="font-code text-[12px] leading-[1.55] text-ink-dim whitespace-pre-wrap break-all m-0">
            {truncateCommand(chars)}
          </pre>
        </MarkerRow>
      </div>
    </MarkerRow>
  )
})
