import { asRecord } from '@shared/lib/asRecord'
import type { ToolUseBlock } from '@shared/types/transcript'

const MAX_IDENTITY_CHARS = 160
const MAX_PREVIEW_CHARS = 400

export type CodexNativeSpawnModel = {
  operationId: string
  agentType: string
  description: string
  prompt: string
  variant: 'legacy-agent-type' | 'named-task'
}
function bound(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const head = Math.floor((maxChars - 1) / 2)
  return `${value.slice(0, head)}…${value.slice(-(maxChars - head - 1))}`
}

export function fromCodexNativeSpawnUse(block: ToolUseBlock): CodexNativeSpawnModel | null {
  if (block.name !== 'spawn_agent') return null
  const input = asRecord(block.input)
  const message = typeof input?.message === 'string' ? input.message : ''
  if (!input || !/\S/.test(block.id) || !/\S/.test(message)) return null

  // Two observed generations coexist: frozen 2026-06 recordings carry
  // `agent_type`, while the current Codex collaboration surface carries a
  // stable `task_name` and optional `fork_turns`. Supporting only these exact
  // discriminators is intentional; future variants visibly fall back to JSON
  // instead of inheriting the old central row's optimistic casts.
  if (typeof input.task_name === 'string' && /\S/.test(input.task_name)) {
    if (input.fork_turns !== undefined && typeof input.fork_turns !== 'string') return null
    return {
      operationId: block.id,
      agentType: bound(input.task_name, MAX_IDENTITY_CHARS),
      description: bound(message, MAX_PREVIEW_CHARS),
      prompt: message,
      variant: 'named-task',
    }
  }
  if (typeof input.agent_type === 'string' && /\S/.test(input.agent_type)) {
    if (input.reasoning_effort !== undefined && typeof input.reasoning_effort !== 'string') {
      return null
    }
    return {
      operationId: block.id,
      agentType: bound(input.agent_type, MAX_IDENTITY_CHARS),
      description: bound(message, MAX_PREVIEW_CHARS),
      prompt: message,
      variant: 'legacy-agent-type',
    }
  }
  return null
}
