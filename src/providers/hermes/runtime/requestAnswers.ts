// Answers to Hermes' blocking requests, shared by the runtime (validation)
// and the renderer views (which compose answers). PURE: no main or electron
// imports, so the renderer can import the action names and the validator
// without dragging the runtime's main-process dependencies along.

import type { HermesConnectionOperation, HermesRequest } from 'hermes-headless'

import type { HermesClarifyQuestion } from '@shared/types/providerConditions'

/** Action names HermesSession.resolveCondition resolves. */
export const HERMES_ANSWER = 'hermes.answer'
export const HERMES_DECLINE = 'hermes.decline'
/** Answer a connection card (Hermes' connection.respond). */
export const HERMES_CONNECTION_RESPOND = 'hermes.connection.respond'

export type HermesConnectionAnswer = {
  targets: Array<{ name: string; status: 'approved' | 'skipped'; env?: Record<string, string> }>
  settledBy?: 'continue'
}

/**
 * The trust boundary for a connection card's answer, like validateAnswer:
 * the view composes it (which row, typed credentials), and this refuses
 * anything the OPEN operation did not ask for — an unknown row, a row that
 * is already resolved, or a credential name its requiredEnv does not list.
 * A required credential left empty on an approval is refused too: Hermes
 * would reject it, and the card should say so before the round trip.
 */
export function validateConnectionAnswer(operation: HermesConnectionOperation, payload: unknown): HermesConnectionAnswer | null {
  const record = asRecord(payload)
  if (!record || operation.settled) return null
  const settledBy = record.settledBy === 'continue' ? 'continue' as const : undefined
  if (record.settledBy !== undefined && !settledBy) return null
  const rawTargets = Array.isArray(record.targets) ? record.targets : []
  const targets: HermesConnectionAnswer['targets'] = []
  for (const entry of rawTargets) {
    const answer = asRecord(entry)
    if (!answer || typeof answer.name !== 'string') return null
    const target = operation.targets.find((candidate) => candidate.name === answer.name)
    if (!target || target.resolved) return null
    if (answer.status !== 'approved' && answer.status !== 'skipped') return null
    if (answer.status === 'skipped') {
      targets.push({ name: target.name, status: 'skipped' })
      continue
    }
    const env = asRecord(answer.env) ?? {}
    const allowed = new Map(target.requiredEnv.map((field) => [field.name, field]))
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
      if (!allowed.has(key) || typeof value !== 'string' || value.length > 8000) return null
      if (value.trim()) out[key] = value
    }
    if (target.requiredEnv.some((field) => field.required && !out[field.name])) return null
    targets.push({ name: target.name, status: 'approved', ...(Object.keys(out).length > 0 ? { env: out } : {}) })
  }
  if (targets.length === 0 && !settledBy) return null
  return { targets, ...(settledBy ? { settledBy } : {}) }
}

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
