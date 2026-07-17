import type { ReactNode } from 'react'

import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { renderOpencodeReadResult } from '@providers/opencode/renderer/components/read-result'
import { fromOpencodeTodoUse } from '@providers/opencode/renderer/adapters/todo'
import { OpencodeTodoRow } from '@providers/opencode/renderer/components/todo'
import type {
  ProviderOperationDecision,
  ProviderOperationInput,
} from '@shared/types/providerConfig'
import { fromOpencodeGitOperation } from '@providers/opencode/renderer/adapters/git'
import { GitOperationView } from '@providers/shared/renderer/protocols/command/formatters/git'

export function renderOpencodeOperation(
  input: ProviderOperationInput,
): ProviderOperationDecision {
  const git = fromOpencodeGitOperation(input)
  if (git) {
    return {
      toolUse: {
        action: 'render',
        node: <GitOperationView model={git} />,
        receipt: { rendererId: 'shared.command', protocolId: 'command.git' },
      },
      toolResult: input.result
        ? {
            action: 'absorb',
            ownerRenderId: 'shared.command',
            protocolId: 'command.git',
            reason: 'paired Git operation view preserves the bounded result evidence',
          }
        : null,
    }
  }
  const toolUse = renderOpencodeToolUse(input.toolUse)
  const toolResult = input.result
    ? renderOpencodeToolResult(input.result, { sourceTool: input.toolUse })
    : undefined
  return {
    toolUse: toolUse === undefined
      ? { action: 'fallback' }
      : {
          action: 'render',
          node: toolUse,
          receipt: { rendererId: 'opencode.rows.dispatch' },
        },
    toolResult: !input.result
      ? null
      : toolResult === undefined
        ? { action: 'fallback' }
        : toolResult === null
          ? {
              action: 'absorb',
              ownerRenderId: 'opencode.rows.dispatch',
              reason: 'provider operation card validated and consumed its paired result',
            }
          : {
              action: 'render',
              node: toolResult,
              receipt: { rendererId: 'opencode.rows.dispatch' },
            },
  }
}

// OpenCode committed/live tool rows.
//
// Everything else (read/glob/bash/task/…) intentionally falls through to the
// generic ToolUseRow/ToolResultRow: the probe showed their inputs/results
// are plain path/pattern/command payloads the generic rows present fine.
// Specialized rows (diff-style edit rendering etc.) should be added here one
// evidence-backed tool at a time, not speculatively.
function renderOpencodeToolUse(block: ToolUseBlock): ReactNode | undefined {
  const todo = fromOpencodeTodoUse(block)
  return todo ? <OpencodeTodoRow model={todo} /> : undefined
}

function renderOpencodeToolResult(
  block: ToolResultBlock,
  context: { sourceTool?: ToolUseBlock | null },
): ReactNode | undefined {
  const source = context.sourceTool?.name
  // TODO(phase-7-opencode-todo-result): capture a durable paired result and
  // add a parse-fully-or-decline adapter before absorbing any todowrite echo.
  // The only retained evidence proves the invocation schema, not that every
  // success/error result repeats the checklist. A name-only null here used to
  // delete drifted and failed results; the shared structured fallback is the
  // honest owner until the result grammar itself is proven.
  // read results are a tagged text document (<path>/<type>/<content>
  // soup). Parse and present as a code slab with the real path; fall
  // through to the generic row when the shape doesn't match.
  if (source === 'read') {
    const row = renderOpencodeReadResult(block)
    if (row !== undefined) return row
  }
  return undefined
}
