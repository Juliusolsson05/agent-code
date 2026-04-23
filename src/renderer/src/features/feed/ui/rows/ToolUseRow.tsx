import { memo } from 'react'

import type { ToolUseBlock } from '@shared/types/transcript'

import { truncateBashCommand } from '../../lib/helpers'
import { MarkerRow } from '../MarkerRow'

/* ---------- Tool use: "⏺ Bash  ⎿ $ command" ---------- */

// Generic tool_use row — the fallback renderer when the tool name
// doesn't match one of the per-tool rich rows (Edit / MultiEdit /
// Write / TodoWrite for Claude; provider dispatchers for Codex).
// Shows "⏺ <ToolName>" followed by a muted `⎿ <headline>` line with
// the command / description / path pulled from the tool's input
// object.
//
// Bash commands get the 2-line / 160-char cap claude-code's Ink UI
// enforces (see claude-code-src/full/tools/BashTool/UI.tsx). The
// truncateBashCommand helper applies the same caps so the feed reads
// like the upstream TUI — long / multiline invocations collapse with
// a trailing `…`. The whole command remains in the transcript; the
// collapse is purely a density choice so a 20-line heredoc doesn't
// push the next assistant message below the fold.
export const ToolUseRow = memo(function ToolUseRow({ block }: { block: ToolUseBlock }) {
  // Extract the command / description for Bash-like tools. For tools
  // without a `command` field we fall back to stringified input.
  const input = block.input as Record<string, unknown> | undefined
  const rawHeadline = typeof input?.command === 'string'
    ? input.command
    : typeof input?.description === 'string'
      ? input.description
      : typeof input?.path === 'string'
        ? input.path
        : null

  // Bash commands get the 2-line / 160-char cap claude-code's Ink UI
  // enforces. `description` and `path` headlines are already one-line-
  // ish so we only truncate when the headline came from `command`.
  const headline = (() => {
    if (!rawHeadline) return null
    if (block.name === 'Bash' && typeof input?.command === 'string') {
      return truncateBashCommand(input.command)
    }
    return rawHeadline
  })()

  return (
    <MarkerRow marker="⏺">
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
