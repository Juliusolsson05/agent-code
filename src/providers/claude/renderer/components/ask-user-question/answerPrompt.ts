// Serialize AskUserQuestion answers into a prompt for the "answer via message"
// path (the deliberate workaround for multi-select / multi-question / free-text
// — see docs/decomposition/2026-07-23-auq-answer-via-prompt.md).
//
// WHY this exists instead of driving the TUI: Claude's AskUserQuestion picker
// cannot be reliably keystroke-driven for multi-select / multi-question /
// free-text (the "Submit answers" review screen, wrapped checkboxes, and the
// free-text field all defeat screen-scraping, and each Claude release re-breaks
// it). Instead we dismiss the picker with Esc — Claude records the tool as
// declined — and send the choices as this structured message. Verified live
// (v2.1.218): Claude reads it and continues with the correct selections.
//
// The framing sentence matters: because the tool was *declined*, Claude needs
// to be told these are the answers to that question, not a fresh request. The
// XML makes the mapping unambiguous even for multi-question calls.

// The answer shape the row already builds (see AskUserQuestionRow's
// submitStructuredAnswers / handleSingleOption). Labels here are the FULL,
// untruncated provider strings (`answerLabel ?? label`, etc.).
export type AnswerForPrompt = {
  question: string
  header?: string
  multiSelect?: boolean
  selectedOptions?: Array<{ label: string; number?: number }>
  selectedLabels?: string[]
  text?: string
}

// Minimal XML text escaping. The values are human answer strings, never markup,
// so escaping the five XML metacharacters is sufficient and keeps the payload
// readable in the transcript.
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// The exact labels chosen for a single answer, preferring the structured
// options (which carry the full label) and falling back to selectedLabels.
function chosenLabels(answer: AnswerForPrompt): string[] {
  if (answer.selectedOptions?.length) {
    return answer.selectedOptions.map(option => option.label).filter(label => label.length > 0)
  }
  return (answer.selectedLabels ?? []).filter(label => label.length > 0)
}

const FRAMING =
  'I answered your question(s) below. The picker was dismissed — treat the ' +
  'following as my selections and continue.'

/**
 * Build the full prompt string (framing + XML) for a set of answers, or null
 * when there is nothing to send (no selections and no free text anywhere) —
 * the caller should not deliver an empty answer.
 */
export function answersToPrompt(answers: AnswerForPrompt[]): string | null {
  const blocks: string[] = []
  for (const answer of answers) {
    const labels = chosenLabels(answer)
    const text = answer.text?.trim() ?? ''
    if (labels.length === 0 && text.length === 0) continue
    const parts: string[] = [`  <answer>`, `    <question>${escapeXml(answer.question)}</question>`]
    for (const label of labels) parts.push(`    <selected>${escapeXml(label)}</selected>`)
    if (text.length > 0) parts.push(`    <text>${escapeXml(text)}</text>`)
    parts.push(`  </answer>`)
    blocks.push(parts.join('\n'))
  }
  if (blocks.length === 0) return null
  return `${FRAMING}\n\n<user-answers>\n${blocks.join('\n')}\n</user-answers>`
}
