import { readAskQuestions, type AskQuestion } from '@renderer/features/feed/lib/askUserQuestion'
import { asRecord } from '@shared/lib/asRecord'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

export type ClaudeQuestionModel = {
  operationId: string
  input: Record<string, unknown>
  questions: readonly AskQuestion[]
}

export function fromClaudeQuestionUse(block: ToolUseBlock): ClaudeQuestionModel | null {
  if (block.name !== 'AskUserQuestion' || !/\S/.test(block.id)) return null
  const input = asRecord(block.input)
  if (!input) return null
  const questions = readAskQuestions(input)
  return questions.length > 0 ? { operationId: block.id, input, questions } : null
}

export function fromClaudeQuestionResult(
  result: ToolResultBlock,
  model: ClaudeQuestionModel,
): string | null {
  if (result.tool_use_id !== model.operationId) return null
  // WHY an error must not be absorbed as an answer: interrupted/declined
  // questions often carry human-readable text, but that text is failure
  // evidence, not a durable selection. Declining keeps it in the generic error
  // row and prevents a green answered marker from manufacturing success.
  if (result.is_error === true) return null
  if (typeof result.content === 'string') return result.content
  if (!Array.isArray(result.content) || result.content.length !== 1) return null
  const item = asRecord(result.content[0])
  if (
    !item ||
    item.type !== 'text' ||
    typeof item.text !== 'string' ||
    Object.keys(item).some(key => key !== 'type' && key !== 'text')
  ) return null
  return item.text
}
