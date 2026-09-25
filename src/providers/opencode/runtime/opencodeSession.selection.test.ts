import { describe, expect, it, vi } from 'vitest'

// A prompt must carry the conversation's OWN agent, model and variant (#1038
// review). OpenCode resolves a submission's model as
// `input.model ?? agent.model ?? session model`, so a machine-level
// `agent.build.model` outranks the session's selection: a duplicated session
// kept its model in every imported message and then answered the next prompt
// on whatever this machine's config named. The reviewer reproduced that
// against the 1.18.30 binary.
//
// The session-row shape below is the real one, copied from a live 1.18.31
// database: `agent` beside `model: { id, providerID, variant }` — note `id`,
// not `modelID` as a MESSAGE spells it.

const control = vi.hoisted(() => ({
  prompts: [] as Array<Record<string, unknown>>,
  session: null as unknown,
  getSessionCalls: 0,
  onGetSession: undefined as (() => void) | undefined,
}))

vi.mock('opencode-headless', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    OpencodeHeadless: class FakeOpencodeHeadless extends EventEmitter {
      readonly screen = new EventEmitter()
      readonly committed = new EventEmitter()
      readonly semantic = new EventEmitter()
      async start(): Promise<void> {
        // The real package announces the live session id this way; the app
        // tracks it because the package's own copy is private.
        this.emit('ready', { url: 'http://127.0.0.1:1', sessionID: 'ses_live' })
      }
      readonly client = {
        getSession: async (): Promise<unknown> => {
          control.getSessionCalls += 1
          control.onGetSession?.()
          if (control.session instanceof Error) throw control.session
          return control.session
        },
      }
      async stop(): Promise<void> {}
      async prompt(input: Record<string, unknown>): Promise<unknown> {
        control.prompts.push(input)
        return {}
      }
    },
  }
})

import { OpencodeSession } from './opencodeSession.js'

async function started(): Promise<OpencodeSession> {
  control.prompts = []
  control.getSessionCalls = 0
  const session = new OpencodeSession({ cwd: '/tmp/project' })
  await session.start()
  return session
}

describe('OpencodeSession prompt selection', () => {
  it('sends the session row\'s agent, model and variant together', async () => {
    control.session = {
      id: 'ses_live',
      agent: 'build',
      model: { id: 'glm-5.3', providerID: 'zai-coding-plan', variant: 'max' },
    }
    const session = await started()
    await session.deliverPromptText('continue')
    expect(control.prompts).toEqual([{
      prompt: 'continue',
      // The destination is pinned WITH the selection: the row read is async,
      // and a default destination would send this session's model to whatever
      // session became current meanwhile.
      sessionID: 'ses_live',
      agent: 'build',
      providerID: 'zai-coding-plan',
      modelID: 'glm-5.3',
      variant: 'max',
    }])
  })

  it('re-reads the row per prompt, because the TUI can change it underneath us', async () => {
    control.session = { agent: 'build', model: { id: 'a', providerID: 'p', variant: 'default' } }
    const session = await started()
    await session.deliverPromptText('one')
    control.session = { agent: 'plan', model: { id: 'b', providerID: 'p', variant: 'max' } }
    await session.deliverPromptText('two')
    expect(control.getSessionCalls).toBe(2)
    expect(control.prompts[1]).toMatchObject({ agent: 'plan', modelID: 'b', variant: 'max' })
  })

  it('sends nothing when the session changed while its row was in flight', async () => {
    // The row read is async. If the pane switches conversations while it is in
    // flight — a reload, a resume, the TUI navigating — the default
    // destination is now a DIFFERENT session, and submitting A's agent, model
    // and variant there writes them onto B's row, permanently (#1038
    // re-review reproduced this against the real package).
    control.session = { agent: 'build', model: { id: 'a', providerID: 'p', variant: 'max' } }
    const session = await started()
    control.onGetSession = () => {
      // B becomes the live session while A's row is being read.
      ;(session as unknown as { liveSessionId: string }).liveSessionId = 'ses_other'
    }
    await session.deliverPromptText('continue')
    control.onGetSession = undefined
    expect(control.prompts).toEqual([{ prompt: 'continue' }])
  })

  it('sends no selection at all when the row cannot be read or is incomplete', async () => {
    // Whatever shipped before this existed is the fallback: no selection, and
    // the server applies its own defaults. A HALF selection would be worse
    // than none — OpenCode persists what a prompt selects, so a model without
    // an agent re-homes the conversation to the default agent for good.
    for (const row of [
      new Error('offline'),
      null,
      { agent: 'build' },
      { model: { id: 'a' } },
      // A complete model and variant, but no agent: OpenCode would fill the
      // agent in itself and persist that choice onto the row.
      { model: { id: 'a', providerID: 'p', variant: 'max' } },
      // An agent and a model, but no variant: same trap, the effort level.
      { agent: 'build', model: { id: 'a', providerID: 'p' } },
    ]) {
      control.session = row
      const session = await started()
      await session.deliverPromptText('hello')
      expect(control.prompts).toEqual([{ prompt: 'hello' }])
    }
  })
})
