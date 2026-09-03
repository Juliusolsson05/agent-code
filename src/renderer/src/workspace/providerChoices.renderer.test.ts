import { describe, expect, it } from 'vitest'

import {
  AGENT_PROVIDER_CHOICES,
  providerSwitchChoices,
} from '@renderer/workspace/providerChoices'

function keys(source: 'claude' | 'codex' | 'opencode'): string[] {
  return providerSwitchChoices(source).map(
    choice => `${choice.kind}:${choice.providerRuntime ?? 'structured'}`,
  )
}

describe('provider switch choices', () => {
  it('uses the same OpenCode runtime expansion as the new-agent picker', () => {
    expect(AGENT_PROVIDER_CHOICES.map(choice => choice.label)).toEqual([
      'Claude',
      'Codex',
      'OpenCode',
      'OpenCode Terminal',
    ])
    expect(keys('claude')).toEqual([
      'codex:structured',
      'opencode:structured',
      'opencode:terminal',
    ])
    expect(keys('codex')).toEqual([
      'claude:structured',
      'opencode:structured',
      'opencode:terminal',
    ])
  })

  it('omits both OpenCode runtimes when OpenCode is already the source provider', () => {
    expect(keys('opencode')).toEqual(['claude:structured', 'codex:structured'])
  })
})
