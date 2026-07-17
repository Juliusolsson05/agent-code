import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { claudeBashResultText } from '@providers/claude/renderer/adapters/command'
import { gitOperationModel } from '@providers/shared/renderer/protocols/command/formatters/git'
import type { GitOperationModel } from '@providers/shared/renderer/protocols/command/formatters/git'
import { asRecord } from '@shared/lib/asRecord'

export function fromClaudeGitOperation(input: {
  toolUse: ToolUseBlock
  result: ToolResultBlock | null
}): GitOperationModel | null {
  if (input.toolUse.name !== 'Bash') return null
  const command = asRecord(input.toolUse.input)?.command
  if (typeof command !== 'string') return null
  return gitOperationModel({
    command,
    resultPresent: input.result !== null,
    output: input.result ? claudeBashResultText(input.result) : undefined,
    isError: input.result?.is_error === true,
  })
}
