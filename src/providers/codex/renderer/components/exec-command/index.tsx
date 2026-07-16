// Codex `exec_command` component (dir-per-component convention, PR #555 —
// see providers/claude/renderer/components/edit/index.tsx for the rule).

import { memo, useMemo } from 'react'

import type { ToolUseBlock } from '@shared/types/transcript'
import { fromCodexExecCommand } from '@providers/codex/renderer/adapters/command'
import { CommandView } from '@providers/shared/renderer/protocols/command/CommandView'
import { CodexToolRow } from '@providers/codex/renderer/components/tool'

export const CodexExecCommandRow = memo(function CodexExecCommandRow({
  block,
}: {
  block: ToolUseBlock
}) {
  // CUT OVER to the command protocol (PR #555 Phase 6): adapter → shared
  // CommandView (bash-highlighted headline, shared status grammar).
  // Preserved from the legacy row per the consultation checklist: cmd-first
  // parsing with bounded array joins (inside execCommandInput), the
  // whitespace-only fallback to CodexToolRow, and yield/max metadata (the
  // adapter folds them into the conclusion line). Output still arrives on
  // the separate result row — unchanged pairing shape.
  const model = useMemo(() => fromCodexExecCommand(block), [block])
  if (!model) return <CodexToolRow block={block} />
  return <CommandView model={model} />
})
