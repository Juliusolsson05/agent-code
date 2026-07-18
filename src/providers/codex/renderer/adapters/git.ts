import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { fromCodexCommandOperation } from '@providers/codex/renderer/adapters/command'
import { gitOperationModel } from '@providers/shared/renderer/protocols/command/formatters/git'
import type { GitOperationModel } from '@providers/shared/renderer/protocols/command/formatters/git'

export function fromCodexGitOperation(input: {
  toolUse: ToolUseBlock
  result: ToolResultBlock | null
}): GitOperationModel | null {
  const command = fromCodexCommandOperation({
    toolUse: input.toolUse,
    result: input.result,
  })
  if (!command) return null
  // WHY a correlated but unowned result blocks Git admission: the Git view
  // absorbs its result row. A transparent single-call wrapper proves where
  // output lives; an arbitrary/fan-out script does not. Falling back keeps the
  // complete provider result visible instead of letting a command substring
  // hide unrelated JavaScript output.
  if (input.result && !command.ownsResult) return null
  return gitOperationModel({
    command: command.rawCommand,
    resultPresent: input.result !== null,
    output: command.model.output,
    isError: command.model.status === 'failure',
    // The `text(r.output)` carrier owns the bytes but not the exit code
    // (command.ts commandResultEvidence). The Git view must not enter the
    // rich success cards on it: a rejected push or failed guard chain would
    // parse as a clean success card. `unknown` keeps the exact output in the
    // neutral command grammar with an explicit "exit unknown" state.
    exitUnknown: command.model.status === 'unknown',
  })
}
