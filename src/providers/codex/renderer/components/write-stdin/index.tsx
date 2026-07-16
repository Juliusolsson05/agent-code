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

  // WHY empty write_stdin renders nothing:
  // Codex uses write_stdin for two very different things: real input
  // into an ongoing command, and empty/poll continuation calls while
  // a long-running PTY command is still draining output. The latter
  // created the ugly one-line `write_stdin` rows visible in the
  // 2026-05-16T18:54 bundle: no path, no command, no payload, just a
  // provider implementation detail. Empty stdin has no user-visible
  // content, so the command/result row remains the owner of the UI.
  if (!chars) return null

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
