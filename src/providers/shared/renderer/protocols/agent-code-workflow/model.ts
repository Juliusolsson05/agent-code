import { parseWorkflowToolResult } from '@renderer/features/workflows/model/workflowTool'
import { asRecord } from '@shared/lib/asRecord'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

export type AgentCodeWorkflowTool = 'workflow_run' | 'workflow_resume'

export type AgentCodeWorkflowModel = {
  operationId: string
  tool: AgentCodeWorkflowTool
  action: 'Run workflow' | 'Resume workflow'
  subject: string
  input: Record<string, unknown>
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && /\S/.test(value) ? value : null
}

export function fromAgentCodeWorkflowUse(
  block: ToolUseBlock,
  tool: AgentCodeWorkflowTool,
): AgentCodeWorkflowModel | null {
  const input = asRecord(block.input)
  if (!input || !/\S/.test(block.id)) return null

  if (tool === 'workflow_run') {
    const scriptPath = nonEmptyString(input.scriptPath)
    const script = nonEmptyString(input.script)
    const name = nonEmptyString(input.name)
    if (!scriptPath && !script && !name) return null
    return {
      operationId: block.id,
      tool,
      action: 'Run workflow',
      subject: nonEmptyString(input.title) ?? scriptPath ?? name ?? 'Inline workflow',
      input,
    }
  }

  const runId = nonEmptyString(input.runId)
  const claudeRunPath = nonEmptyString(input.claudeRunPath)
  if (!runId && !claudeRunPath) return null
  return {
    operationId: block.id,
    tool,
    action: 'Resume workflow',
    subject: runId ?? claudeRunPath!,
    input,
  }
}

export function fromAgentCodeWorkflowResult(
  result: ToolResultBlock,
  model: AgentCodeWorkflowModel,
) {
  if (result.tool_use_id !== model.operationId || result.is_error === true) return null
  return parseWorkflowToolResult(result)
}
