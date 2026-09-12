import { describe, expect, it } from 'vitest'
import { TLDR_GOAL_CONTEXT, TLDR_NEVER_WRITTEN_REASON, TLDR_STALE_REASON, TldrEnforcement } from './enforcement'

function setup() {
  let clock = 1_000_000
  const written = new Map<string, string>()
  const enforcement = new TldrEnforcement({ lastWrittenAt: async (identity: string) => written.get(identity) }, () => clock)
  return {
    enforcement,
    tick: (ms = 1_000) => { clock += ms },
    report: (identity: string) => { written.set(identity, new Date(clock).toISOString()) },
    hook: (event: 'user-prompt-submit' | 'post-tool-use' | 'stop', input: unknown = {}, token = 'process-a', identity = 'agent-a') =>
      enforcement.handle(token, identity, event, input),
  }
}

const block = (reason: string) => ({ decision: 'block', reason })

describe('TLDR turn-end enforcement', () => {
  it('asks for the goal at the prompt only while the agent has never reported', async () => {
    const t = setup()
    expect(await t.hook('user-prompt-submit')).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: TLDR_GOAL_CONTEXT },
    })
    t.report('agent-a')
    t.tick()
    expect(await t.hook('user-prompt-submit')).toEqual({})
  })

  it('blocks the end of a turn once when the agent never reported, then lets it finish', async () => {
    const t = setup()
    await t.hook('user-prompt-submit')
    expect(await t.hook('stop')).toEqual(block(TLDR_NEVER_WRITTEN_REASON))
    // The agent may decline. A second stop must never become a loop, even when
    // a provider omits stop_hook_active.
    expect(await t.hook('stop')).toEqual({})
  })

  it('never blocks a pure-chat turn once a TLDR exists', async () => {
    const t = setup()
    t.report('agent-a')
    t.tick()
    await t.hook('user-prompt-submit')
    expect(await t.hook('stop')).toEqual({})
  })

  it('asks once after a tool-using turn that did not report, honouring stop_hook_active', async () => {
    const t = setup()
    t.report('agent-a')
    t.tick()
    await t.hook('user-prompt-submit')
    await t.hook('post-tool-use')
    // The earlier report predates this prompt, so it describes the last turn.
    expect(await t.hook('stop')).toEqual(block(TLDR_STALE_REASON))
    expect(await t.hook('stop', { stop_hook_active: true })).toEqual({})
  })

  it('lets a tool-using turn finish when it reported during that turn', async () => {
    const t = setup()
    t.report('agent-a')
    t.tick()
    await t.hook('user-prompt-submit')
    t.tick()
    await t.hook('post-tool-use')
    t.report('agent-a')
    expect(await t.hook('stop')).toEqual({})
  })

  it('dates the turn from its first tool call when the prompt hook was missed', async () => {
    const t = setup()
    t.report('agent-a')
    t.tick()
    // A reload mid-turn means no prompt hook for this process.
    await t.hook('post-tool-use')
    expect(await t.hook('stop')).toEqual(block(TLDR_STALE_REASON))

    const late = setup()
    await late.hook('post-tool-use')
    late.tick()
    late.report('agent-a')
    expect(await late.hook('stop')).toEqual({})
  })

  it('keeps turns isolated per provider process and forgets a revoked one', async () => {
    const t = setup()
    t.report('agent-a')
    t.report('agent-b')
    t.tick()
    await t.hook('user-prompt-submit', {}, 'process-a', 'agent-a')
    await t.hook('post-tool-use', {}, 'process-a', 'agent-a')
    await t.hook('user-prompt-submit', {}, 'process-b', 'agent-b')
    // B did no tool work; A's unreported turn must not leak into it.
    expect(await t.hook('stop', {}, 'process-b', 'agent-b')).toEqual({})
    // A reload revokes A's token. Its successor must start clean rather than
    // inherit a turn the old process never finished.
    t.enforcement.forget('process-a')
    expect(await t.hook('stop', {}, 'process-a', 'agent-a')).toEqual({})
  })

  it('reports hook contact per identity and forgets it with the process that made it', async () => {
    const t = setup()
    expect(t.enforcement.status(['agent-a'])).toEqual({ 'agent-a': { hookContactAt: null } })
    await t.hook('post-tool-use')
    expect(t.enforcement.status(['agent-a'])['agent-a']!.hookContactAt).toBe(new Date(1_000_000).toISOString())
    // A reload keeps the identity. The old process's contact must not vouch for
    // a replacement whose hooks never run.
    t.enforcement.forget('process-a')
    expect(t.enforcement.status(['agent-a'])).toEqual({ 'agent-a': { hookContactAt: null } })
  })

  it('ignores subagent hooks so a child can neither reset, nudge, nor contaminate the parent turn', async () => {
    const never = setup()
    // A child spawned before the parent ever reported must not be asked for a
    // goal: it would write its own sub-task into the parent's TLDR.
    expect(await never.hook('user-prompt-submit', { agent_id: 'child', turn_id: 'c1' })).toEqual({})

    const t = setup()
    t.report('agent-a')
    t.tick()
    await t.hook('user-prompt-submit', { turn_id: 't1' })
    await t.hook('post-tool-use', { turn_id: 't1' })
    await t.hook('user-prompt-submit', { agent_id: 'child', agent_type: 'default', turn_id: 'c1' })
    await t.hook('post-tool-use', { agent_id: 'child', turn_id: 'c1' })
    expect(await t.hook('stop', { turn_id: 't1' })).toEqual(block(TLDR_STALE_REASON))

    const background = setup()
    background.report('agent-a')
    background.tick()
    await background.hook('user-prompt-submit')
    // A background Task from an earlier turn keeps calling tools; the parent's
    // current turn is still a pure question.
    await background.hook('post-tool-use', { agent_id: 'background-task' })
    expect(await background.hook('stop')).toEqual({})
  })

  it('keeps a steer into the same Codex turn from erasing unreported tool work', async () => {
    const t = setup()
    t.report('agent-a')
    t.tick()
    await t.hook('user-prompt-submit', { turn_id: 't1' })
    await t.hook('post-tool-use', { turn_id: 't1' })
    t.tick()
    expect(await t.hook('user-prompt-submit', { turn_id: 't1', prompt: 'stop and summarize' })).toEqual({})
    expect(await t.hook('stop', { turn_id: 't1' })).toEqual(block(TLDR_STALE_REASON))
    // A genuinely new turn still starts clean.
    t.report('agent-a')
    t.tick()
    await t.hook('user-prompt-submit', { turn_id: 't2' })
    expect(await t.hook('stop', { turn_id: 't2' })).toEqual({})
  })
})
