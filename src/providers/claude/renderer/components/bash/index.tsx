// Claude `Bash` live streaming component (PR #555 Phase 6; dir-per-component
// convention — see components/edit/index.tsx).
//
// WHY this lives in a provider component, not BlockRow: the import-boundary
// test (correctly) rejected the feed importing a provider adapter directly —
// the feed may only reach Claude through the grandfathered ClaudeRows
// specifier, and provider composition belongs in provider files anyway.
// STREAMING-FIRST: paints the moment the `command` string closes in the
// partial JSON; nothing before that. The COMMITTED Bash card is dispatched
// straight from rows/dispatch.tsx (adapter → CommandView, no wrapper needed);
// this component exists because the live plane hands us partial-JSON text,
// not a finished ToolUseBlock.

import { memo, useMemo } from 'react'

import type { ToolUseBlock } from '@shared/types/transcript'
import {
  fromClaudeBashBlock,
  fromClaudeBashCodeEdit,
  fromClaudePartialBashCodeEdit,
  fromClaudePartialBashJson,
} from '@providers/claude/renderer/adapters/command'
import { CommandView } from '@providers/shared/renderer/protocols/command/CommandView'
import { CodeEditView } from '@providers/shared/renderer/protocols/code-edit/CodeEditView'
import { JsonToolRow } from '@providers/shared/renderer/rows/JsonToolRow'

export const ClaudeLiveBashRow = memo(function ClaudeLiveBashRow({
  parsedInput,
  inputJson,
  finalized,
  blockIndex,
}: {
  parsedInput: Record<string, unknown> | null
  inputJson: string
  finalized: boolean
  blockIndex: number
}) {
  // A cat-heredoc write streams as a growing code-edit card, exactly like a
  // streaming Write — content lines appear as they arrive (the extractor is
  // trustworthy the moment the command's first line closes). Tried BEFORE the
  // command model so the write's content is never hidden behind a headline;
  // it declines for every non-heredoc command, which then paints as before.
  const editModel = useMemo(
    () =>
      parsedInput
        ? fromClaudeBashCodeEdit(
            { type: 'tool_use', id: `live:${blockIndex}`, name: 'Bash', input: parsedInput } as ToolUseBlock,
            { streaming: !finalized },
          )
        : fromClaudePartialBashCodeEdit(inputJson),
    [parsedInput, inputJson, finalized, blockIndex],
  )
  const commandModel = useMemo(
    () =>
      parsedInput
        ? fromClaudeBashBlock(
            { type: 'tool_use', id: `live:${blockIndex}`, name: 'Bash', input: parsedInput } as ToolUseBlock,
            { streaming: !finalized },
          )
        : fromClaudePartialBashJson(inputJson),
    [parsedInput, inputJson, finalized, blockIndex],
  )
  if (editModel) return <CodeEditView model={editModel} />
  if (!commandModel) {
    // Returning null here used to erase the live invocation because BlockRow
    // had already committed to this provider component. Preserve the raw
    // partial shape through the same bounded generic row used everywhere else.
    return (
      <JsonToolRow
        block={{
          type: 'tool_use',
          id: `live:${blockIndex}`,
          name: 'Bash',
          input: parsedInput ?? { inputJson },
        } as ToolUseBlock}
      />
    )
  }
  return <CommandView model={commandModel} />
})
