import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { rawCodexExecCommand, stripCodexTransportEnvelope } from '@providers/codex/renderer/adapters/command'
import { gitOperationModel } from '@providers/shared/renderer/protocols/command/formatters/git'
import type { GitOperationModel } from '@providers/shared/renderer/protocols/command/formatters/git'
import { toolResultContentText } from '@providers/shared/renderer/rows/toolResultContent'

export function fromCodexGitOperation(input: {
  toolUse: ToolUseBlock
  result: ToolResultBlock | null
}): GitOperationModel | null {
  // Unified `exec` is arbitrary JavaScript and may contain multiple commands;
  // claiming it from one substring would hide unrelated output. Only the
  // observed single-command envelope earns this formatter.
  if (input.toolUse.name !== 'exec_command') return null
  const command = rawCodexExecCommand(input.toolUse.input)
  if (!command) return null
  return gitOperationModel({
    command,
    resultPresent: input.result !== null,
    output: input.result
      ? stripCodexTransportEnvelope(toolResultContentText(input.result.content))
      : undefined,
    isError: input.result?.is_error === true,
  })
}
