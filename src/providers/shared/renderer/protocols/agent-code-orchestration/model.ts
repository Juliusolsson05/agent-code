import { asRecord } from '@shared/lib/asRecord'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'
import { tryExtractJson } from '@providers/shared/renderer/rows/jsonToolPresentation'

// Agent Code orchestration is a protocol we own, not a guess about MCP in
// general. Provider adapters are responsible for proving that their wire name
// denotes *our* server before they call these parsers: Claude preserves the
// `mcp__agent_code__` namespace while Codex currently presents the same tools
// as bare names. Keeping name recognition out of this shared model prevents an
// unrelated MCP server's coincidentally named `orchestration_*` tool from being
// interpreted as an Agent Code lifecycle record.

export type AgentCodeOrchestrationOperation =
  | 'create-agent'
  | 'send-prompt'
  | 'list-agents'
  | 'read-agent'
  | 'read-run-outputs'
  | 'wait-agents'
  | 'close-agent'
  | 'close-run'

export type AgentCodeOrchestrationUseModel = {
  operationId: string
  operation: AgentCodeOrchestrationOperation
  input: Record<string, unknown>
}
export type AgentCodeOrchestrationResultModel = {
  operation: AgentCodeOrchestrationOperation
  value: Record<string, unknown>
  /** Exact provider-normalized transport source for lazy forensic paging. */
  source: string
}

function optionalString(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || typeof record[key] === 'string'
}

function requiredString(record: Record<string, unknown>, key: string): boolean {
  return typeof record[key] === 'string' && /\S/.test(record[key] as string)
}

function validKnownInput(
  operation: AgentCodeOrchestrationOperation,
  input: Record<string, unknown>,
): boolean {
  switch (operation) {
    case 'create-agent':
      return (
        optionalString(input, 'kind') &&
        optionalString(input, 'prompt') &&
        optionalString(input, 'cwd') &&
        optionalString(input, 'title') &&
        optionalString(input, 'role') &&
        optionalString(input, 'runId')
      )
    case 'send-prompt':
      return requiredString(input, 'sessionId') && requiredString(input, 'prompt')
    case 'list-agents':
    case 'read-run-outputs':
    case 'close-run':
      return optionalString(input, 'runId')
    case 'read-agent':
    case 'close-agent':
      return requiredString(input, 'sessionId')
    case 'wait-agents':
      return (
        optionalString(input, 'runId') &&
        (input.sessionIds === undefined || (
          Array.isArray(input.sessionIds) &&
          input.sessionIds.every(value => typeof value === 'string')
        ))
      )
  }
}

export function fromAgentCodeOrchestrationUse(
  block: ToolUseBlock,
  operation: AgentCodeOrchestrationOperation,
): AgentCodeOrchestrationUseModel | null {
  const input = asRecord(block.input)
  if (!input || !/\S/.test(block.id) || !validKnownInput(operation, input)) return null
  return { operationId: block.id, operation, input }
}

function exactResultSource(content: ToolResultBlock['content']): string | null {
  if (typeof content === 'string') return content
  // The Agent Code MCP server emits exactly one text content block. Refusing
  // to join multiple typed blocks is deliberate: image/resource blocks and
  // future structured content have semantics this protocol view does not yet
  // represent, so the generic result renderer must keep them visible.
  if (!Array.isArray(content) || content.length !== 1) return null
  const only = content[0]
  if (typeof only === 'string') return only
  const record = asRecord(only)
  if (
    !record ||
    record.type !== 'text' ||
    typeof record.text !== 'string' ||
    Object.keys(record).some(key => key !== 'type' && key !== 'text')
  ) {
    return null
  }
  return record.text
}

function validAgent(value: unknown): boolean {
  const agent = asRecord(value)
  return Boolean(
    agent &&
    requiredString(agent, 'sessionId') &&
    requiredString(agent, 'kind') &&
    requiredString(agent, 'cwd'),
  )
}

function validOutput(value: unknown): boolean {
  const output = asRecord(value)
  return Boolean(
    output &&
    validAgent(output.agent) &&
    Array.isArray(output.messages),
  )
}

function validSuccessPayload(
  operation: AgentCodeOrchestrationOperation,
  value: Record<string, unknown>,
): boolean {
  switch (operation) {
    case 'create-agent':
      return validAgent(value.agent)
    case 'send-prompt':
      return requiredString(value, 'sessionId')
    case 'list-agents':
      return Array.isArray(value.agents) && value.agents.every(validAgent)
    case 'read-agent':
      return validOutput(value.output)
    case 'read-run-outputs':
      return Array.isArray(value.outputs) && value.outputs.every(validOutput)
    case 'wait-agents':
      return (
        typeof value.done === 'boolean' &&
        Array.isArray(value.agents) &&
        value.agents.every(validAgent) &&
        Array.isArray(value.outputs) &&
        value.outputs.every(validOutput)
      )
    case 'close-agent':
    case 'close-run':
      return (
        Array.isArray(value.closedSessionIds) &&
        value.closedSessionIds.every(item => typeof item === 'string') &&
        (value.skippedSessionIds === undefined || (
          Array.isArray(value.skippedSessionIds) &&
          value.skippedSessionIds.every(item => typeof item === 'string')
        ))
      )
  }
}

export function fromAgentCodeOrchestrationResult(
  block: ToolResultBlock,
  source: AgentCodeOrchestrationUseModel,
): AgentCodeOrchestrationResultModel | null {
  if (block.tool_use_id !== source.operationId) return null
  const exact = exactResultSource(block.content)
  if (exact === null) return null
  const parsed = tryExtractJson(exact)
  const value = asRecord(parsed)
  if (!value || typeof value.ok !== 'boolean') return null

  // Agent Code failures intentionally have several operation/stage-specific
  // shapes. `ok:false` is the stable discriminator and the raw protocol
  // disclosure preserves every detail, so requiring one invented universal
  // error schema would reject truthful failures. Successful results are held
  // to the operation contract before their generic result can be absorbed.
  if (value.ok === true && !validSuccessPayload(source.operation, value)) return null
  return { operation: source.operation, value, source: exact }
}
