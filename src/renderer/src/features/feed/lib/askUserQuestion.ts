import { asRecord } from '@shared/lib/asRecord'

// Shared AskUserQuestion input parsing (P2d). Extracted from the semantic
// AskUserQuestionRow so the committed-plane row reads the SAME shapes —
// the two planes drifting apart is how the 06-17/06-21 bundles happened
// (semantic got a real picker, committed kept painting raw JSON).

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

/** Narrow loosely-typed tool input into renderable questions. Returns []
 *  when nothing usable parsed so callers can show a placeholder. */
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
      const orec = asRecord(o)
      if (!orec) continue
      const label = typeof orec.label === 'string' ? orec.label : ''
      if (!label) continue
      options.push({
        label,
        description: typeof orec.description === 'string' ? orec.description : undefined,
        preview: typeof orec.preview === 'string' ? orec.preview : undefined,
      })
    }
    if (!question && options.length === 0) continue
    questions.push({ question, header, multiSelect, options })
  }
  return questions
}
