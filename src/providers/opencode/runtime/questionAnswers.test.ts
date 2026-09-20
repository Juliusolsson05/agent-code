import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

import { parseOpencodeQuestions, validateQuestionAnswers } from './questionAnswers'
import type { OpencodeQuestion } from '@shared/types/providerConditions'

// ---------------------------------------------------------------------------
// The trust boundary for #1025. The view has to compose a multi-question
// answer — one positional set, submitted together — so this is what stops it
// from composing something OpenCode never offered.
//
// Every case here is a thing a buggy or hostile renderer could send, not a
// thing the current view does. That is the point: the boundary must hold
// whatever the view does.
// ---------------------------------------------------------------------------

const colour: OpencodeQuestion = {
  question: 'Do you prefer the color red or blue?',
  header: 'Color preference',
  options: [{ label: 'Red', description: 'The color red' }, { label: 'Blue', description: 'The color blue' }],
}
const size: OpencodeQuestion = { question: 'Size?', options: [{ label: 'Small' }, { label: 'Large' }] }

describe('validateQuestionAnswers', () => {
  it('accepts a label that was offered', () => {
    expect(validateQuestionAnswers([colour], [['Blue']])).toEqual([['Blue']])
  })

  it('keeps multi-question answers in question order', () => {
    // Positional: entry 0 answers question 0. This is the whole reason the
    // arity check below matters.
    expect(validateQuestionAnswers([colour, size], [['Red'], ['Large']])).toEqual([['Red'], ['Large']])
  })

  it('refuses a label that was never offered', () => {
    // The renderer speaking for OpenCode — exactly what this prevents.
    expect(validateQuestionAnswers([colour], [['Green']])).toBeNull()
    expect(validateQuestionAnswers([colour], [['red']])).toBeNull() // case matters on the wire
  })

  it('refuses an answer borrowed from another question', () => {
    // 'Large' is a real label, just not for this question. A set-membership
    // check that ignored position would let this through.
    expect(validateQuestionAnswers([colour, size], [['Large'], ['Blue']])).toBeNull()
  })

  it('refuses the wrong number of answers', () => {
    // Short or long, the positional mapping is broken and someone gets an
    // answer they did not ask for.
    expect(validateQuestionAnswers([colour, size], [['Red']])).toBeNull()
    expect(validateQuestionAnswers([colour], [['Red'], ['Large']])).toBeNull()
  })

  it('refuses an empty selection for a question that HAS options', () => {
    // The wire would accept `[]` and tell the agent "no answer" for a question
    // the user believes they answered.
    expect(validateQuestionAnswers([colour], [[]])).toBeNull()
  })

  it('accepts the empty selection ONLY where nothing was offered', () => {
    const open: OpencodeQuestion = { question: 'Anything?', options: [] }
    expect(validateQuestionAnswers([open], [[]])).toEqual([[]])
    // …and still refuses a claim about options that do not exist.
    expect(validateQuestionAnswers([open], [['Invented']])).toBeNull()
  })

  it('refuses anything that is not an array of arrays of strings', () => {
    for (const bad of [null, undefined, 'Blue', ['Blue'], [[1]], [[null]], [{}], 42]) {
      expect(validateQuestionAnswers([colour], bad), JSON.stringify(bad) ?? 'undefined').toBeNull()
    }
  })

  it('refuses everything when nothing was published', () => {
    // No live question means no authority to answer one.
    expect(validateQuestionAnswers([], [['Blue']])).toBeNull()
    expect(validateQuestionAnswers([], [])).toBeNull()
  })
})

describe('parseOpencodeQuestions, on the REAL recorded payload', () => {
  // The raw question payload from the recorded live stream — the same bytes
  // `metadata` carries at the seam `foldQuestion` reads.
  const recorded = (() => {
    const raw = JSON.parse(readFileSync(
      resolve(__dirname, '../../../../packages/opencode-terminal-headless/testing/fixtures/live/question-reject.json'),
      'utf8',
    )) as unknown
    let found: unknown = null
    const walk = (node: unknown): void => {
      if (found) return
      if (Array.isArray(node)) { for (const item of node) walk(item); return }
      if (!node || typeof node !== 'object') return
      if (Array.isArray((node as { questions?: unknown }).questions)) { found = node; return }
      for (const value of Object.values(node)) walk(value)
    }
    walk(raw)
    return found
  })()

  it('finds the questions, options and descriptions the stream really carries', () => {
    const questions = parseOpencodeQuestions(recorded)
    expect(questions).toHaveLength(1)
    expect(questions[0]!.question).toContain('red or blue')
    expect(questions[0]!.header).toBe('Color preference')
    expect(questions[0]!.options).toEqual([
      { label: 'Red', description: 'The color red' },
      { label: 'Blue', description: 'The color blue' },
    ])
  })

  it('round-trips: every parsed label is one the validator will accept', () => {
    // The two halves of the boundary have to agree, or the modal offers a
    // button whose answer is then refused.
    const questions = parseOpencodeQuestions(recorded)
    for (const option of questions[0]!.options) {
      expect(validateQuestionAnswers(questions, [[option.label]])).toEqual([[option.label]])
    }
  })

  it('yields nothing rather than guessing at a shape it cannot read', () => {
    for (const bad of [null, undefined, 42, 'questions', {}, { questions: 'no' }, { questions: [null, 7] }]) {
      expect(parseOpencodeQuestions(bad)).toEqual([])
    }
  })

  it('keeps a question whose options are unreadable, so it can still be rejected', () => {
    // Dropping the question entirely would leave an empty modal; dropping only
    // the bad options leaves something honest on screen.
    const questions = parseOpencodeQuestions({
      questions: [{ question: 'Pick', options: [{ label: '' }, { nope: 1 }, 'x'] }],
    })
    expect(questions).toEqual([{ question: 'Pick', options: [] }])
  })
})
