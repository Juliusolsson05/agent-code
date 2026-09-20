import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// The RUNTIME half of #1025, which the renderer suite cannot reach.
//
// The #1068 review found four mutations that deleted this half outright and
// left all 77 opencode tests green: publishing no per-option actions at all,
// skipping `validateQuestionAnswers` entirely, replying with a hardcoded
// wrong label, and never clearing the modal. The cause was that the renderer
// test hand-wrote its own copy of the actions `foldQuestion` is supposed to
// publish and asserted against that copy — exactly the "copy that drifts"
// the PR's own comments warn about.
//
// So these tests drive the REAL `OpencodeSession` with the REAL recorded
// question payload, through the real screen event that `foldQuestion`
// listens on, and assert on what actually reached the wire. Nothing here
// restates a literal the implementation also holds.
// ---------------------------------------------------------------------------

type ReplyCall = { questionID: string; answers: unknown }

const control = vi.hoisted(() => ({
  replies: [] as ReplyCall[],
  rejects: [] as string[],
  /** Set to hold `replyQuestion` open, so a question can be REPLACED while a
   *  click is still in flight — the race behind review finding 2. */
  gate: null as null | (() => Promise<void>),
}))

vi.mock('opencode-headless', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    OpencodeHeadless: class FakeOpencodeHeadless extends EventEmitter {
      readonly screen = new EventEmitter()
      readonly committed = new EventEmitter()
      readonly semantic = new EventEmitter()
      async start(): Promise<void> {
        this.emit('ready', { url: 'http://127.0.0.1:1', sessionID: 'ses_live' })
      }
      readonly client = { getSession: async (): Promise<unknown> => null }
      async stop(): Promise<void> {}
      async prompt(): Promise<unknown> { return {} }
      async replyQuestion(questionID: string, answers: unknown): Promise<unknown> {
        if (control.gate) await control.gate()
        control.replies.push({ questionID, answers })
        return {}
      }
      async rejectQuestion(questionID: string): Promise<unknown> {
        control.rejects.push(questionID)
        return {}
      }
    },
  }
})

import { OpencodeSession } from './opencodeSession.js'
import { OPENCODE_QUESTION_REJECT, OPENCODE_QUESTION_REPLY } from './questionAnswers.js'
import type { ConditionCustomAction, OpencodeQuestionState } from '@shared/types/providerConditions.js'

/** The `metadata` OpenCode really put on the wire, out of the recorded live
 *  stream — not a literal shaped like it. */
const RECORDED_METADATA = (() => {
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
  if (!found) throw new Error('the recording no longer carries a questions payload')
  return found
})()

type Harness = {
  session: OpencodeSession
  ask: (state: Record<string, unknown>) => void
  live: () => { state: OpencodeQuestionState; actions: ConditionCustomAction[] } | null
}

async function harness(): Promise<Harness> {
  control.replies = []
  control.rejects = []
  control.gate = null
  const session = new OpencodeSession({ cwd: '/tmp/project' })
  await session.start()
  // The screen emitter the session subscribed to in start(); the only way in
  // is the same event the live package emits.
  const headless = (session as unknown as { headless: { screen: { emit: (name: string, ev: unknown) => void } } }).headless
  let latest: Harness['live'] extends () => infer R ? R : never = null
  session.on('conditions', (snapshot: { conditions: Record<string, unknown> }) => {
    const record = snapshot.conditions['opencode.question'] as
      | { state: OpencodeQuestionState; actions: ConditionCustomAction[] }
      | undefined
    latest = record ?? null
  })
  return {
    session,
    ask: state => headless.screen.emit('question', { state }),
    live: () => latest,
  }
}

const RECORDED_ASK = { visible: true, questionID: 'que_recorded', text: 'Do you prefer red or blue?', metadata: RECORDED_METADATA }

describe('foldQuestion publishes the answers the recording really offers (#1025)', () => {
  it('builds one action per recorded option, plus Reject', async () => {
    const { ask, live } = await harness()
    ask(RECORDED_ASK)

    const record = live()
    expect(record).not.toBeNull()
    // Derived from the recording, so a change to the fixture changes the
    // expectation with it — there is no second hand-written copy to drift.
    const offered = record!.state.questions!.map(question => question.options.map(option => option.label)).flat()
    expect(offered.length).toBeGreaterThan(0)
    for (const label of offered) {
      const action = record!.actions.find(candidate => candidate.label === label)
      expect(action, `no action published for the recorded option ${label}`).toBeDefined()
      expect(action!.name).toBe(OPENCODE_QUESTION_REPLY)
      expect(action!.payload).toMatchObject({ questionID: 'que_recorded', answers: [[label]] })
    }
    expect(record!.actions.find(candidate => candidate.name === OPENCODE_QUESTION_REJECT)).toBeDefined()
  })

  it('publishes NO per-option action for a multi-question prompt', async () => {
    // `answers` is one positional submission, so a single click cannot answer
    // a set. Publishing per-option actions here would let the view send a
    // one-entry reply for a two-question prompt.
    const { ask, live } = await harness()
    ask({
      visible: true,
      questionID: 'que_multi',
      metadata: { questions: [
        { question: 'Colour?', options: [{ label: 'Red' }] },
        { question: 'Size?', options: [{ label: 'Large' }] },
      ] },
    })
    expect(live()!.actions.filter(action => action.name === OPENCODE_QUESTION_REPLY)).toEqual([])
    expect(live()!.actions.filter(action => action.name === OPENCODE_QUESTION_REJECT)).toHaveLength(1)
  })
})

describe('resolving a question reply reaches the wire correctly', () => {
  const reply = (questionID: string, answers: unknown): ConditionCustomAction => ({
    kind: 'custom', id: 'x', label: 'Answer', name: OPENCODE_QUESTION_REPLY, payload: { questionID, answers },
  })

  it('sends exactly the labels that were chosen', async () => {
    const { session, ask, live } = await harness()
    ask(RECORDED_ASK)
    const label = live()!.state.questions![0]!.options[1]!.label
    expect(await session.resolveCondition(reply('que_recorded', [[label]]))).toEqual({ ok: true })
    expect(control.replies).toEqual([{ questionID: 'que_recorded', answers: [[label]] }])
  })

  it('refuses a label the runtime never published, and sends NOTHING', async () => {
    // The trust boundary, exercised through the session rather than the pure
    // function — this is the path a renderer actually reaches.
    const { session, ask } = await harness()
    ask(RECORDED_ASK)
    expect(await session.resolveCondition(reply('que_recorded', [['Chartreuse']])))
      .toEqual({ ok: false, reason: 'invalid-payload' })
    expect(control.replies).toEqual([])
  })

  it('clears the modal once answered, so the question does not linger', async () => {
    const { session, ask, live } = await harness()
    ask(RECORDED_ASK)
    const label = live()!.state.questions![0]!.options[0]!.label
    await session.resolveCondition(reply('que_recorded', [[label]]))
    expect(live()).toBeNull()
  })

  it('refuses a reply aimed at a question that is no longer live', async () => {
    // Review finding 2. `que_old`'s action was built before the swap; the
    // options now live belong to `que_new`. Validating one question's answer
    // against another's options is how "Yes" to a changelog entry became
    // "Yes" to dropping a database.
    const { session, ask, live } = await harness()
    ask({ visible: true, questionID: 'que_old', metadata: { questions: [{ question: 'Deploy?', options: [{ label: 'Yes' }] }] } })
    ask({ visible: true, questionID: 'que_new', metadata: { questions: [{ question: 'Delete the database?', options: [{ label: 'Yes' }] }] } })

    expect(await session.resolveCondition(reply('que_old', [['Yes']])))
      .toEqual({ ok: false, reason: 'invalid-payload' })
    expect(control.replies).toEqual([])
    // …and the question the user is actually looking at is still there.
    expect(live()!.state.questionID).toBe('que_new')
  })

  it('does not tear down a question that arrived while the reply was in flight', async () => {
    // The second half of finding 2: the id matched when we started, so the
    // reply is correct and must be sent — but the unconditional delete that
    // followed destroyed a DIFFERENT question's modal, leaving its agent
    // blocked with nothing on screen to unblock it.
    const { session, ask, live } = await harness()
    ask({ visible: true, questionID: 'que_a', metadata: { questions: [{ question: 'Deploy?', options: [{ label: 'Yes' }] }] } })

    let release: () => void = () => {}
    control.gate = () => new Promise<void>(resolve => { release = resolve })
    const inFlight = session.resolveCondition(reply('que_a', [['Yes']]))
    ask({ visible: true, questionID: 'que_b', metadata: { questions: [{ question: 'Force push?', options: [{ label: 'No' }] }] } })
    release()

    expect(await inFlight).toEqual({ ok: true })
    expect(control.replies).toEqual([{ questionID: 'que_a', answers: [['Yes']] }])
    expect(live()!.state.questionID).toBe('que_b')
  })
})

describe('rejecting is guarded the same way', () => {
  const rejectAction = (questionID: string): ConditionCustomAction => ({
    kind: 'custom', id: 'x', label: 'Reject', name: OPENCODE_QUESTION_REJECT, payload: { questionID },
  })

  it('rejects the live question', async () => {
    const { session, ask, live } = await harness()
    ask(RECORDED_ASK)
    expect(await session.resolveCondition(rejectAction('que_recorded'))).toEqual({ ok: true })
    expect(control.rejects).toEqual(['que_recorded'])
    expect(live()).toBeNull()
  })

  it('refuses to reject a question that has already been replaced', async () => {
    // Pre-existing on this arm and the reason the guard is shared: rejecting
    // `que_old` used to tear down `que_new`'s modal too.
    const { session, ask, live } = await harness()
    ask({ visible: true, questionID: 'que_old', metadata: { questions: [{ question: 'Deploy?', options: [{ label: 'Yes' }] }] } })
    ask({ visible: true, questionID: 'que_new', metadata: { questions: [{ question: 'Delete?', options: [{ label: 'Yes' }] }] } })
    expect(await session.resolveCondition(rejectAction('que_old')))
      .toEqual({ ok: false, reason: 'invalid-payload' })
    expect(control.rejects).toEqual([])
    expect(live()!.state.questionID).toBe('que_new')
  })
})
