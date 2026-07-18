import { asRecord } from '@shared/lib/asRecord'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

// Claude collaboration wire -> provider-owned model (Phase 7, PR #555).
// This intentionally recognizes only the built-in Agent grammar captured in
// fresh recordings. MCP orchestration and Codex collaboration have different
// input/result/lifecycle contracts; treating all spawn-like names as one wire
// schema is the legacy coupling this cutover is removing.

const MAX_AGENT_TYPE_CHARS = 120
const MAX_DESCRIPTION_CHARS = 400
const MAX_RESULT_TEXT_BLOCKS = 20

export type ClaudeAgentModel = {
  operationId: string
  agentType: string
  description: string
  prompt: string
  background: boolean
}

export type ClaudeAgentResultModel = {
  texts: readonly string[]
}

function boundScalar(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const head = Math.floor((maxChars - 1) / 2)
  const tail = maxChars - head - 1
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

export function fromClaudeAgentUse(block: ToolUseBlock): ClaudeAgentModel | null {
  if (block.name !== 'Agent') return null
  const input = asRecord(block.input)
  const rawType = typeof input?.subagent_type === 'string' ? input.subagent_type : ''
  const rawDescription = typeof input?.description === 'string' ? input.description : ''
  const prompt = typeof input?.prompt === 'string' ? input.prompt : ''
  const rawBackground = input?.run_in_background
  if (
    !/\S/.test(block.id) ||
    !/\S/.test(rawType) ||
    !/\S/.test(rawDescription) ||
    !/\S/.test(prompt)
  )
    return null
  // The optional flag is the one captured variant. A future string/enum form
  // must fall back visibly instead of silently becoming foreground work.
  if (rawBackground !== undefined && typeof rawBackground !== 'boolean') return null

  return {
    operationId: block.id,
    agentType: boundScalar(rawType, MAX_AGENT_TYPE_CHARS),
    description: boundScalar(rawDescription, MAX_DESCRIPTION_CHARS),
    prompt,
    background: rawBackground ?? false,
  }
}

export function fromClaudeAgentResult(
  result: ToolResultBlock,
  source: ToolUseBlock,
): ClaudeAgentResultModel | null {
  if (!fromClaudeAgentUse(source)) return null
  if (result.tool_use_id !== source.id || result.is_error === true) return null
  if (!Array.isArray(result.content)) return null
  // Result absorption is stricter than enrichment: if any admitted field
  // cannot be represented, the shared generic result must remain visible.
  // A size cap therefore DECLINES the whole result rather than truncating it,
  // and exact key checking prevents a future meaningful field disappearing
  // merely because the familiar text field was also present.
  if (result.content.length === 0 || result.content.length > MAX_RESULT_TEXT_BLOCKS) return null

  const texts: string[] = []
  for (const item of result.content) {
    const record = asRecord(item)
    if (!record || record.type !== 'text' || typeof record.text !== 'string') return null
    if (!/\S/.test(record.text)) return null
    if (Object.keys(record).some((key) => key !== 'type' && key !== 'text')) return null
    texts.push(record.text)
  }
  return { texts }
}
