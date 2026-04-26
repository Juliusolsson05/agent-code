import { memo } from 'react'

import type { ToolUseBlock } from '@shared/types/transcript'

import { truncateBashCommand } from '@renderer/features/feed/lib/helpers'
import { MarkerRow } from '@renderer/features/feed/ui/MarkerRow'

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
  // Headline lookup order mirrors `workIndicatorHints.toolHintFromBlock`
  // so the row's "⎿ …" line carries the same identifier the work
  // indicator showed while the tool was running.
  //
  // The historic chain was `command → description → path`, written when
  // this row was Bash-only. That left every file-op tool (Read,
  // NotebookRead, etc.) with a blank body because Read's argument is
  // `file_path`, not `path` — observed in 2026-04-25T10-10-36 debug
  // bundle as ~75 orphan-ghost rows reading just "Read" with no
  // argument. We now check `command` (Bash), then the path-shaped
  // fields any file-op might use, then search/network identifiers,
  // then `description` as the last-ditch free-form fallback.
  //
  // `description` deliberately moves to the bottom: Bash's
  // `description` is a redundant gloss of `command`, and other tools
  // that accept a description usually also have a more specific
  // identifier. If we hit `description` we've exhausted everything
  // else.
  const input = block.input as Record<string, unknown> | undefined
  const pickString = (key: string): string | null => {
    const v = input?.[key]
    return typeof v === 'string' && v.length > 0 ? v : null
  }
  const rawHeadline =
    pickString('command') ??
    pickString('file_path') ??
    pickString('path') ??
    pickString('notebook_path') ??
    pickString('pattern') ??
    pickString('query') ??
    pickString('url') ??
    pickString('description')

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
