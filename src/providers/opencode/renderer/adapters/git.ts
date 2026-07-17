import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { asRecord } from '@shared/lib/asRecord'
import { gitOperationModel } from '@providers/shared/renderer/protocols/command/formatters/git'
import type { GitOperationModel } from '@providers/shared/renderer/protocols/command/formatters/git'
import { toolResultContentText } from '@providers/shared/renderer/rows/toolResultContent'

export function fromOpencodeGitOperation(input: {
  toolUse: ToolUseBlock
  result: ToolResultBlock | null
}): GitOperationModel | null {
  if (input.toolUse.name !== 'bash') return null
  const command = asRecord(input.toolUse.input)?.command
  if (typeof command !== 'string') return null
  return gitOperationModel({
    command,
    resultPresent: input.result !== null,
    output: input.result ? toolResultContentText(input.result.content) : undefined,
    isError: input.result?.is_error === true,
  })
}
