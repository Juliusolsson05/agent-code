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

describe('publishProviderSessionObserved', () => {
  it('emits provider_session_observed on both the named and catch-all channels', () => {
    const channel = new SemanticChannel()
    const named: SemanticEvent[] = []
    const all: SemanticEvent[] = []
    channel.on('provider_session_observed', e => named.push(e))
    channel.on('event', e => all.push(e))

    channel.publishProviderSessionObserved({
      provider: 'claude',
      providerSessionId: 'claude-session-1',
      flowId: 'flow-1',
      source: 'proxy',
      confidence: 'high',
    })

    expect(named).toHaveLength(1)
    expect(all).toHaveLength(1)
    expect(named[0]).toMatchObject({
      type: 'provider_session_observed',
      provider: 'claude',
      providerSessionId: 'claude-session-1',
      flowId: 'flow-1',
      source: 'proxy',
      confidence: 'high',
    })
    expect(typeof (named[0] as { ts: number }).ts).toBe('number')
  })
})
