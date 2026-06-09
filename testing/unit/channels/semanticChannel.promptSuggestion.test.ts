import { describe, it, expect } from 'vitest'

import { SemanticChannel } from '../../../packages/claude-code-headless/src/channels/SemanticChannel'
import type { SemanticEvent } from '../../../packages/claude-code-headless/src/channels/types'

describe('publishPromptSuggestion', () => {
  it('emits a prompt_suggestion event on both the named and catch-all channels', () => {
    const channel = new SemanticChannel()
    const named: SemanticEvent[] = []
    const all: SemanticEvent[] = []
    channel.on('prompt_suggestion', e => named.push(e))
    channel.on('event', e => all.push(e))

    channel.publishPromptSuggestion({
      flowId: 'flow-1',
      turnId: 'msg_1',
      text: 'run the tests',
      source: 'proxy',
    })

    expect(named).toHaveLength(1)
    expect(all).toHaveLength(1)
    expect(named[0]).toMatchObject({
      type: 'prompt_suggestion',
      text: 'run the tests',
      flowId: 'flow-1',
      turnId: 'msg_1',
    })
    expect(typeof (named[0] as { ts: number }).ts).toBe('number')
  })
})
