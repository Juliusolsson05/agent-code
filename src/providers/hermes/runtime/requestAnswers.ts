// Answers to Hermes' blocking requests, shared by the runtime (validation)
// and the renderer views (which compose answers). PURE: no main or electron
// imports, so the renderer can import the action names and the validator
// without dragging the runtime's main-process dependencies along.

import type { HermesRequest } from 'hermes-headless'

import type { HermesClarifyQuestion } from '@shared/types/providerConditions'

/** Action names HermesSession.resolveCondition resolves. */
export const HERMES_ANSWER = 'hermes.answer'
export const HERMES_DECLINE = 'hermes.decline'

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

export function clarifyQuestions(params: Record<string, unknown>): HermesClarifyQuestion[] {
  const raw = Array.isArray(params.questions) ? params.questions : []
  return raw.flatMap((entry) => {
    const record = asRecord(entry)
    if (!record || typeof record.qid !== 'string' || typeof record.question !== 'string') return []
    return [{
      qid: record.qid,
      question: record.question,
      choices: Array.isArray(record.choices) ? record.choices.filter((choice): choice is string => typeof choice === 'string') : [],
      multiSelect: record.multi_select === true,
    }]
  })
}

/**
 * The trust boundary for view-composed answers: the renderer may COMPOSE an
 * answer (typed text, a multi-select) but must never invent one Hermes did
 * not ask for. Returns the wire result, or null when the payload does not fit
 * this request.
 */
export function validateAnswer(request: HermesRequest, result: unknown): Record<string, unknown> | null {
  const record = asRecord(result)
  if (!record) return null
  switch (request.method) {
    case 'approval': {
      const offered = Array.isArray(request.params.choices) ? request.params.choices : ['once', 'deny']
      return typeof record.choice === 'string' && offered.includes(record.choice) ? { choice: record.choice } : null
    }
    case 'clarify': {
      const answers = asRecord(record.answers)
      if (!answers) return null
      const questions = clarifyQuestions(request.params)
      const out: Record<string, string | null> = {}
      for (const question of questions) {
        const value = answers[question.qid]
        if (value === undefined || value === null) {
          out[question.qid] = null
          continue
        }
        if (typeof value !== 'string' || value.length > 4000) return null
        out[question.qid] = value
      }
      // An answer to a question Hermes did not ask is refused outright.
      if (Object.keys(answers).some((qid) => !questions.some((question) => question.qid === qid))) return null
      return { answers: out }
    }
    case 'sudo':
    case 'secret':
      return typeof record.value === 'string' && record.value.length <= 4000 ? { value: record.value } : null
  }
}
