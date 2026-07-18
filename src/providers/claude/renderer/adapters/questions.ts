import { asRecord } from '@shared/lib/asRecord'
import type { ToolResultBlock, ToolUseBlock } from '@shared/types/transcript'

export type AskOption = {
  label: string
  /** Exact provider value used for resolver matching when display text is bounded. */
  answerLabel?: string
  description?: string
  preview?: string
}

export type AskQuestion = {
  question: string
  /** Exact provider values stay off-DOM but must round-trip in the answer. */
  answerQuestion?: string
  header?: string
  answerHeader?: string
  multiSelect?: boolean
  options: AskOption[]
}

const MAX_QUESTIONS = 4
const MAX_OPTIONS_PER_QUESTION = 20
const MAX_QUESTION_CHARS = 2_000
const MAX_HEADER_CHARS = 160
const MAX_OPTION_LABEL_CHARS = 400
const MAX_OPTION_DETAIL_CHARS = 1_000

function boundScalar(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars - 1)}…`
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
  if (questionsRaw.length > MAX_QUESTIONS) return []

  const questions: AskQuestion[] = []
  // WHY both dimensions decline instead of slicing: AskUserQuestion is an
  // interaction protocol, so hiding question five or option twenty-one and
  // then submitting a partial answer would corrupt the live TUI. Four
  // questions is Claude's captured contract; out-of-contract arrays retain
  // their exact evidence through the bounded generic fallback.
  for (const q of questionsRaw) {
    const rec = asRecord(q)
    if (
      !rec ||
      typeof rec.question !== 'string' ||
      !/\S/.test(rec.question) ||
      (rec.header !== undefined && typeof rec.header !== 'string') ||
      (rec.multiSelect !== undefined && typeof rec.multiSelect !== 'boolean') ||
      Object.keys(rec).some(key =>
        key !== 'question' && key !== 'header' && key !== 'multiSelect' && key !== 'options')
    ) return []
    const rawQuestion = rec.question
    const question = boundScalar(rawQuestion, MAX_QUESTION_CHARS)
    const rawHeader = typeof rec.header === 'string' ? rec.header : undefined
    const header = rawHeader !== undefined
      ? boundScalar(rawHeader, MAX_HEADER_CHARS)
      : undefined
    const multiSelect = rec.multiSelect === true
    if (!Array.isArray(rec.options)) return []
    const optionsRaw = rec.options
    if (optionsRaw.length > MAX_OPTIONS_PER_QUESTION) return []
    const options: AskOption[] = []
    for (const o of optionsRaw) {
      const option = asRecord(o)
      if (
        !option ||
        typeof option.label !== 'string' ||
        !/\S/.test(option.label) ||
        (option.description !== undefined && typeof option.description !== 'string') ||
        (option.preview !== undefined && typeof option.preview !== 'string') ||
        Object.keys(option).some(key =>
          key !== 'label' && key !== 'description' && key !== 'preview')
      ) return []
      const label = option.label
      const displayLabel = boundScalar(label, MAX_OPTION_LABEL_CHARS)
      options.push({
        label: displayLabel,
        ...(displayLabel !== label ? { answerLabel: label } : {}),
        description: typeof option.description === 'string'
          ? boundScalar(option.description, MAX_OPTION_DETAIL_CHARS)
          : undefined,
        preview: typeof option.preview === 'string'
          ? boundScalar(option.preview, MAX_OPTION_DETAIL_CHARS)
          : undefined,
      })
    }
    // WHY exact strings ride beside bounded display strings: the structured
    // resolver matches provider labels/questions, so sending an ellipsized
    // value would make a safely rendered option impossible to submit. These
    // exact fields are never painted; transcript evidence remains the source.
    questions.push({
      question,
      ...(question !== rawQuestion ? { answerQuestion: rawQuestion } : {}),
      header,
      ...(header !== rawHeader ? { answerHeader: rawHeader } : {}),
      multiSelect,
      options,
    })
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
