import type { OpencodeQuestion } from '@shared/types/providerConditions.js'

/**
 * Check a submitted answer set against the options the runtime published
 * (#1025).
 *
 * ── WHY THIS IS A SEPARATE, PURE FUNCTION ──
 * It is the trust boundary. The view has to COMPOSE the answer — a
 * multi-question prompt is one positional set, and that is selection state the
 * runtime cannot own — but it must never be able to INVENT one. Keeping the
 * check out of the session makes it something a test can drive directly,
 * rather than something that only runs when a whole session exists.
 *
 * ── WHAT IT REFUSES, AND WHY EACH MATTERS ──
 *  - A different arity. `answers` is positional; a short or long array
 *    silently answers the wrong question, or none.
 *  - A label that was never offered. That is the renderer speaking for
 *    OpenCode, which is the thing this boundary exists to prevent.
 *  - An empty selection for a question that HAS options — the wire would
 *    accept `[]`, and the agent would be told "no answer" for a question the
 *    user believes they answered.
 *
 * A question with NO options is answered with an empty array, deliberately:
 * the provider offered nothing to choose, so an empty selection is the only
 * truthful answer, and refusing it would make such a prompt unanswerable.
 *
 * Returns the normalised answers, or null when anything does not line up.
 * Null is not "assume the user meant something" — it is a refusal.
 */
export function validateQuestionAnswers(
  offered: readonly OpencodeQuestion[],
  submitted: unknown,
): string[][] | null {
  if (offered.length === 0 || !Array.isArray(submitted)) return null
  if (submitted.length !== offered.length) return null

  const answers: string[][] = []
  for (const [index, question] of offered.entries()) {
    const chosen = submitted[index]
    if (!Array.isArray(chosen)) return null
    if (question.options.length === 0) {
      // Nothing was offered, so nothing may be claimed.
      if (chosen.length !== 0) return null
      answers.push([])
      continue
    }
    if (chosen.length === 0) return null
    const labels = new Set(question.options.map(option => option.label))
    const picked: string[] = []
    for (const label of chosen) {
      if (typeof label !== 'string' || !labels.has(label)) return null
      picked.push(label)
    }
    answers.push(picked)
  }
  return answers
}

/**
 * The questions OpenCode is waiting on, out of the raw payload.
 *
 * `LiveStateProjector.questionFromPayload` sets `metadata` to the WHOLE
 * payload, so `questions[].options` has always been here — `foldQuestion`
 * simply never looked, which is why the modal shipped reject-only (#1025) with
 * a comment claiming the options were not available at that seam.
 *
 * Anything malformed yields no options rather than a guess: an option list we
 * cannot read must not become an answer we cannot justify, and a question with
 * no options still renders and can still be rejected. Pure and exported for
 * the same reason as the validator — the parsing rule is worth testing against
 * the real recorded payload without standing up a session.
 */
export function parseOpencodeQuestions(metadata: unknown): OpencodeQuestion[] {
  const payload = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>) : null
  const raw = payload && Array.isArray(payload.questions) ? payload.questions : []
  const questions: OpencodeQuestion[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const question = typeof record.question === 'string' ? record.question : null
    if (!question) continue
    const options: OpencodeQuestion['options'] = []
    for (const option of Array.isArray(record.options) ? record.options : []) {
      if (!option || typeof option !== 'object') continue
      const label = (option as Record<string, unknown>).label
      if (typeof label !== 'string' || label.length === 0) continue
      const description = (option as Record<string, unknown>).description
      options.push({ label, ...(typeof description === 'string' ? { description } : {}) })
    }
    questions.push({
      question,
      ...(typeof record.header === 'string' ? { header: record.header } : {}),
      options,
    })
  }
  return questions
}

/**
 * The custom-action names for the two question arms.
 *
 * ── WHY THEY LIVE HERE, NOT IN `opencodeSession.ts` ──
 * They used to be private constants in the session, under a comment claiming
 * "the two halves can never drift — a rename that touches only one side is a
 * compile error at the other". That stopped being true with #1025: the VIEW
 * now dispatches a reply it composed itself, and filters the runtime's
 * per-option actions out of the footer by matching the same name. Those were
 * two bare string literals on opposite sides of the process boundary, so a
 * rename in the runtime would have compiled clean and broken at runtime — the
 * view dispatching an unknown name (`no-resolver`) and, worse, silently
 * failing to filter, putting every option in the footer twice.
 *
 * This module is the one piece of question logic BOTH halves already import
 * (it is pure, with no main-process dependencies), so it is where a name they
 * must agree on belongs. The comment's promise is now real.
 */
export const OPENCODE_QUESTION_REPLY = 'opencode.question.reply'
export const OPENCODE_QUESTION_REJECT = 'opencode.question.reject'
