import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OPENCODE_VIEWS, opencodeQuestionView } from './views'
import { ConditionOutlet } from '@shared/conditions-core/ConditionOutlet'
import type { ConditionAction } from '@shared/conditions-core/contract'
import { validateQuestionAnswers } from '@providers/opencode/runtime/questionAnswers'
import type { OpencodeQuestion, OpencodeQuestionState } from '@shared/types/providerConditions'

// ---------------------------------------------------------------------------
// #1025. Since #878 the modal SHOWED the question but offered only Reject, so
// a user could read "Do you prefer red or blue?" and still not answer it.
//
// The option list was never missing: `LiveStateProjector.questionFromPayload`
// sets `metadata` to the whole raw payload, so `questions[].options` has
// always been there — `foldQuestion`'s comment claiming otherwise was stale.
//
// The single-question payload below is REAL: it is the `questions` array from
// the recorded live stream in
// packages/opencode-terminal-headless/testing/fixtures/live/question-reject.json.
// The multi-question case has no recording; it is built from the wire SCHEMA
// (`answers` is positional, one array of selected labels per question) and is
// labelled as such rather than pretending to be a recording.
// ---------------------------------------------------------------------------

type RecordedPayload = { questions?: OpencodeQuestion[] }

/** The `questions` array exactly as the recorded stream carries it. */
function recordedQuestions(): OpencodeQuestion[] {
  const raw = readFileSync(
    resolve(__dirname, '../../../../../packages/opencode-terminal-headless/testing/fixtures/live/question-reject.json'),
    'utf8',
  )
  const found: OpencodeQuestion[][] = []
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { for (const item of node) walk(item); return }
    if (!node || typeof node !== 'object') return
    const record = node as RecordedPayload & Record<string, unknown>
    if (Array.isArray(record.questions)) found.push(record.questions as OpencodeQuestion[])
    for (const value of Object.values(record)) walk(value)
  }
  walk(JSON.parse(raw))
  return found[0] ?? []
}

const RECORDED = recordedQuestions()

function rejectAction(): ConditionAction {
  return { kind: 'custom', id: 'q1:reject', label: 'Reject', name: 'opencode.question.reject', payload: { questionID: 'q1' } }
}

/** The per-option actions the runtime builds for a single question. */
function optionActions(question: OpencodeQuestion): ConditionAction[] {
  return question.options.map(option => ({
    kind: 'custom' as const,
    id: `q1:answer:${option.label}`,
    label: option.label,
    name: 'opencode.question.reply',
    payload: { questionID: 'q1', answers: [[option.label]] },
  }))
}

function renderView(state: OpencodeQuestionState, actions: ConditionAction[]) {
  const dispatch = vi.fn(async (_action: ConditionAction) => {})
  const Component = opencodeQuestionView.Component as (props: {
    state: OpencodeQuestionState
    actions: ConditionAction[]
    dispatch: (action: ConditionAction) => Promise<void>
  }) => JSX.Element | null
  render(<Component state={state} actions={actions} dispatch={dispatch} />)
  return { dispatch }
}

afterEach(cleanup)

describe('answering a REAL recorded OpenCode question (#1025)', () => {
  it('the recording really carries options — otherwise everything below is vacuous', () => {
    expect(RECORDED).toHaveLength(1)
    expect(RECORDED[0]!.question).toContain('red or blue')
    expect(RECORDED[0]!.options.map(option => option.label)).toEqual(['Red', 'Blue'])
  })

  it('renders the header and every option, not just the question text', () => {
    renderView({ visible: true, questionID: 'q1', questions: RECORDED }, [
      ...optionActions(RECORDED[0]!),
      rejectAction(),
    ])
    expect(screen.getByText(RECORDED[0]!.header!)).toBeInTheDocument()
    for (const option of RECORDED[0]!.options) {
      expect(screen.getByRole('button', { name: option.label })).toBeInTheDocument()
    }
    // Reject survives: answering is added, never substituted.
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument()
  })

  it('answers with the chosen label, through the runtime-built action', () => {
    const { dispatch } = renderView(
      { visible: true, questionID: 'q1', questions: RECORDED },
      [...optionActions(RECORDED[0]!), rejectAction()],
    )
    fireEvent.click(screen.getByRole('button', { name: 'Blue' }))
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0]![0]).toMatchObject({
      name: 'opencode.question.reply',
      payload: { questionID: 'q1', answers: [['Blue']] },
    })
  })

  it('shows each option exactly once', () => {
    // The runtime publishes one action per option AND the block renders them,
    // so an unfiltered footer would show every option twice — once beside its
    // question and once in a row at the bottom with no question attached.
    renderView({ visible: true, questionID: 'q1', questions: RECORDED }, [
      ...optionActions(RECORDED[0]!),
      rejectAction(),
    ])
    expect(screen.getAllByRole('button', { name: 'Red' })).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: 'Blue' })).toHaveLength(1)
  })

  it('falls back to the plain text when nothing parsed', () => {
    // A payload shape we cannot read must still show the question and offer
    // Reject rather than rendering an empty modal.
    renderView({ visible: true, questionID: 'q1', text: 'Unparsed question', questions: [] }, [rejectAction()])
    expect(screen.getByText('Unparsed question')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument()
  })

  it('says so when the provider offered no options', () => {
    renderView(
      { visible: true, questionID: 'q1', questions: [{ question: 'Anything?', options: [] }] },
      [rejectAction()],
    )
    expect(screen.getByText(/offered no options/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument()
  })
})

describe('a multi-question prompt is answered as one positional set', () => {
  // SCHEMA-derived, not recorded: `answers` is documented as "User answers in
  // order of questions (each answer is an array of selected labels)", and no
  // multi-question stream has been captured. Saying so beats dressing an
  // invented payload up as evidence.
  const two: OpencodeQuestion[] = [
    { question: 'Colour?', header: 'Colour', options: [{ label: 'Red' }, { label: 'Blue' }] },
    { question: 'Size?', header: 'Size', options: [{ label: 'Small' }, { label: 'Large' }] },
  ]

  it('will not submit until every question has an answer', () => {
    const { dispatch } = renderView({ visible: true, questionID: 'q1', questions: two }, [rejectAction()])
    const submit = screen.getByRole('button', { name: /each question/i })
    expect(submit).toBeDisabled()

    fireEvent.click(screen.getByRole('button', { name: 'Red' }))
    expect(screen.getByRole('button', { name: /each question/i })).toBeDisabled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('submits the answers in question order once complete', () => {
    const { dispatch } = renderView({ visible: true, questionID: 'q1', questions: two }, [rejectAction()])
    fireEvent.click(screen.getByRole('button', { name: 'Blue' }))
    fireEvent.click(screen.getByRole('button', { name: 'Large' }))
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))

    expect(dispatch).toHaveBeenCalledTimes(1)
    // Positional: entry 0 answers question 0. Swapping them would answer the
    // wrong question, which is why the order is asserted rather than the set.
    expect(dispatch.mock.calls[0]![0]).toMatchObject({
      payload: { questionID: 'q1', answers: [['Blue'], ['Large']] },
    })
  })

  it('labels each block so a choice cannot be attached to the wrong question', () => {
    renderView({ visible: true, questionID: 'q1', questions: two }, [rejectAction()])
    expect(screen.getByText('Question 1 of 2')).toBeInTheDocument()
    expect(screen.getByText('Question 2 of 2')).toBeInTheDocument()
  })
})

describe('the view and the runtime validator agree', () => {
  // The two halves are written independently, so the only way to know the
  // modal is not offering a button whose answer is then silently refused is to
  // run the REAL view's payload through the REAL validator.
  const run = (questions: OpencodeQuestion[], clicks: string[]) => {
    const { dispatch } = renderView({ visible: true, questionID: 'q1', questions }, [rejectAction()])
    for (const label of clicks) fireEvent.click(screen.getByRole('button', { name: label }))
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))
    const submitted = (dispatch.mock.calls[0]?.[0] as { payload?: { answers?: unknown } } | undefined)?.payload?.answers
    return validateQuestionAnswers(questions, submitted)
  }

  it('accepts what the view posts for an ordinary multi-question set', () => {
    const questions: OpencodeQuestion[] = [
      { question: 'Colour?', options: [{ label: 'Red' }, { label: 'Blue' }] },
      { question: 'Size?', options: [{ label: 'Small' }, { label: 'Large' }] },
    ]
    expect(run(questions, ['Blue', 'Small'])).toEqual([['Blue'], ['Small']])
  })

  it('accepts it when one question has no options at all', () => {
    // The view used to post `['']` for such a question — a label OpenCode
    // never offered — so the validator refused the whole set and Submit
    // silently did nothing, leaving the prompt unanswerable.
    const questions: OpencodeQuestion[] = [
      { question: 'Colour?', options: [{ label: 'Red' }] },
      { question: 'Anything?', options: [] },
    ]
    expect(run(questions, ['Red'])).toEqual([['Red'], []])
  })

  it('keeps answers attached to their own question when only later ones are answerable', () => {
    // Positional: a view that filtered to the answerable questions and then
    // indexed the filtered list would answer question 0 with question 1's
    // choice.
    const questions: OpencodeQuestion[] = [
      { question: 'Skip me', options: [] },
      { question: 'Colour?', options: [{ label: 'Red' }, { label: 'Blue' }] },
    ]
    expect(run(questions, ['Blue'])).toEqual([[], ['Blue']])
  })
})

describe('a replaced question never inherits the previous one\'s answer', () => {
  // Review finding 1, driven through the REAL `ConditionOutlet` rather than a
  // hand-rolled rerender, because the whole bug lives in the outlet's mount
  // identity: it keys the view on `condition.kind`, and `foldQuestion`
  // replaces the question record in place, so a new question re-renders the
  // SAME component instance. Asserting that with a spy would only assert my
  // belief about the outlet.
  const outlet = (questions: OpencodeQuestion[], questionID: string) => ({
    provider: 'opencode' as const,
    ts: 0,
    conditions: {
      'opencode.question': {
        kind: 'opencode.question' as const,
        state: { visible: true, questionID, questions },
        actions: [rejectAction()],
      },
    },
  })

  const benign: OpencodeQuestion[] = [
    { question: 'Add a changelog entry?', options: [{ label: 'Yes' }, { label: 'No' }] },
    { question: 'Run the linter first?', options: [{ label: 'Yes' }, { label: 'No' }] },
  ]
  const grave: OpencodeQuestion[] = [
    { question: 'Delete the production database?', options: [{ label: 'Yes' }, { label: 'No' }] },
    { question: 'Force push to main?', options: [{ label: 'Yes' }, { label: 'No' }] },
  ]

  function renderOutlet(questions: OpencodeQuestion[], questionID: string) {
    const dispatch = vi.fn(async (_action: ConditionAction) => {})
    const view = render(
      <ConditionOutlet
        snapshot={outlet(questions, questionID) as never}
        registry={OPENCODE_VIEWS}
        dispatch={dispatch}
        interactionActive
      />,
    )
    return {
      dispatch,
      replace: (next: OpencodeQuestion[], nextID: string) => view.rerender(
        <ConditionOutlet
          snapshot={outlet(next, nextID) as never}
          registry={OPENCODE_VIEWS}
          dispatch={dispatch}
          interactionActive
        />,
      ),
    }
  }

  it('does not carry a selection across the swap, even when the labels match', () => {
    // The labels are identical ('Yes'/'Yes'), so the trust boundary is
    // structurally unable to help: 'Yes' IS a label the new question offers.
    // Only the view knows the click belonged to a question that is gone.
    const { dispatch, replace } = renderOutlet(benign, 'que_benign')
    const yeses = screen.getAllByRole('button', { name: 'Yes' })
    fireEvent.click(yeses[0]!)
    fireEvent.click(yeses[1]!)
    expect(screen.getByRole('button', { name: 'Answer' })).toBeEnabled()

    replace(grave, 'que_grave')

    expect(screen.getByText('Delete the production database?')).toBeInTheDocument()
    // The gate is closed again: nothing has been chosen for THIS question.
    expect(screen.getByRole('button', { name: /each question/i })).toBeDisabled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('answers the new question with the new question\'s clicks', () => {
    const { dispatch, replace } = renderOutlet(benign, 'que_benign')
    fireEvent.click(screen.getAllByRole('button', { name: 'Yes' })[0]!)
    replace(grave, 'que_grave')

    const nos = screen.getAllByRole('button', { name: 'No' })
    fireEvent.click(nos[0]!)
    fireEvent.click(nos[1]!)
    fireEvent.click(screen.getByRole('button', { name: 'Answer' }))

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0]![0]).toMatchObject({
      payload: { questionID: 'que_grave', answers: [['No'], ['No']] },
    })
  })
})

describe('a multi-question set where nothing has options is still answerable', () => {
  it('submits all-empty answers instead of disabling the button forever', () => {
    // Review finding 5. The validator accepts `[[],[]]` — the provider
    // offered nothing, so an empty selection is the only truthful answer —
    // but the gate demanded at least one answerable question, so the button
    // read "Choose an option for each question" when there was nothing to
    // choose and the prompt could only be rejected.
    const questions: OpencodeQuestion[] = [
      { question: 'Anything?', options: [] },
      { question: 'Anything else?', options: [] },
    ]
    const { dispatch } = renderView({ visible: true, questionID: 'q1', questions }, [rejectAction()])
    const submit = screen.getByRole('button', { name: 'Answer' })
    expect(submit).toBeEnabled()
    fireEvent.click(submit)
    const answers = (dispatch.mock.calls[0]![0] as { payload: { answers: unknown } }).payload.answers
    expect(answers).toEqual([[], []])
    expect(validateQuestionAnswers(questions, answers)).toEqual([[], []])
  })
})
