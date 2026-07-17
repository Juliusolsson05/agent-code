import { asRecord } from '@shared/lib/asRecord'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

export type AskOption = {
  label: string
  description?: string
  preview?: string
}

export type AskQuestion = {
  question: string
  header?: string
  multiSelect?: boolean
  options: AskOption[]
}

// WHY this decoder is provider-owned: the `questions` object is Claude's wire
// contract, not a generic feed shape. Both live and committed Claude painters
// must narrow it through one function so a provider release cannot make the
// interactive row and its durable answer disagree about what was asked.
export function readAskQuestions(
  parsedInput: Record<string, unknown> | null | undefined,
): AskQuestion[] {
  const questionsRaw = parsedInput?.questions
  if (!Array.isArray(questionsRaw)) return []

  const questions: AskQuestion[] = []
  for (const q of questionsRaw) {
    const rec = asRecord(q)
    if (!rec) continue
    const question = typeof rec.question === 'string' ? rec.question : ''
    const header = typeof rec.header === 'string' ? rec.header : undefined
    const multiSelect = rec.multiSelect === true
    const optionsRaw = Array.isArray(rec.options) ? rec.options : []
    const options: AskOption[] = []
    for (const o of optionsRaw) {
      const option = asRecord(o)
      if (!option) continue
      const label = typeof option.label === 'string' ? option.label : ''
      if (!label) continue
      options.push({
        label,
        description: typeof option.description === 'string' ? option.description : undefined,
        preview: typeof option.preview === 'string' ? option.preview : undefined,
      })
    }
    if (!question && options.length === 0) continue
    questions.push({ question, header, multiSelect, options })
  }
  return questions
}

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
