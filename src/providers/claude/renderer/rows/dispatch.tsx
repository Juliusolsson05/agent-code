import type { ReactNode } from 'react'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
// Provider-internal imports reach the component DIRECTORIES directly —
// rows/ClaudeRows.tsx is a barrel that exists only for the feed's
// grandfathered import edge (see its header) and must gain no new users.
import { EditRow } from '@providers/claude/renderer/components/edit'
import { MultiEditRow } from '@providers/claude/renderer/components/multi-edit'
import { WriteRow } from '@providers/claude/renderer/components/write'
import { TodoRow } from '@providers/shared/renderer/components/todo'
import {
  claudeBashConclusion,
  claudeBashResultText,
  fromClaudeBashBlock,
} from '@providers/claude/renderer/adapters/command'
import { CommandView } from '@providers/shared/renderer/protocols/command/CommandView'
import { OutputWell } from '@renderer/lib/text/OutputWell'

export function renderClaudeToolUse(block: ToolUseBlock): ReactNode | undefined {
  // WHY this dispatch lives with the provider rows: these names are Claude Code
  // transcript vocabulary, not feed vocabulary. Keeping the table beside the
  // row components makes adding/removing a Claude tool a provider-local change
  // and lets the shared feed keep one generic fallback for unknown tools.
  switch (block.name) {
    case 'Bash': {
      // Phase 6 cutover: non-git Bash renders through the command protocol
      // (the git-intent subset is intercepted BEFORE dispatch by Block.tsx's
      // widget, so this case only ever sees plain commands or
      // customRendering-off sessions). Whitespace-only input falls through
      // to the generic row, preserved behavior.
      const model = fromClaudeBashBlock(block)
      return model ? <CommandView model={model} /> : undefined
    }
    case 'Edit':
      return <EditRow block={block} />
    case 'MultiEdit':
      return <MultiEditRow block={block} />
    case 'Write':
      return <WriteRow block={block} />
    case 'TodoWrite':
      return <TodoRow block={block} />
    default:
      return undefined
  }
}

export function renderClaudeToolResult(
  block: ToolResultBlock,
  context: { sourceTool?: ToolUseBlock | null },
): ReactNode | undefined {
  // Phase 6: Bash output gets the shared grammar — ANSI-aware OutputWell
  // (head+tail preview so the final error/summary always survives) plus a
  // formatter-registry conclusion line (test totals, JSON size) rendered
  // ABOVE the raw evidence, terminal-only by construction on the committed
  // plane. Everything else keeps the generic result row.
  const source = context.sourceTool
  if (source?.name === 'Bash') {
    const text = claudeBashResultText(block)
    if (!text && block.is_error !== true) {
      // Silent success stays visible as evidence (#524 lesson: an empty
      // stdout must not erase that the command ran) — the command card
      // above already shows it; render a quiet no-output marker.
      return <OutputWell text="" isError={false} />
    }
    const input = (source.input ?? {}) as Record<string, unknown>
    const command = typeof input.command === 'string' ? input.command : ''
    const conclusion = claudeBashConclusion(block, command)
    return (
      <div className="flex flex-col gap-0.5">
        {conclusion ? (
          <div className="text-ink-dim text-[12px] pl-6">{conclusion}</div>
        ) : null}
        <OutputWell text={text} isError={block.is_error === true} />
      </div>
    )
  }
  return undefined
}
