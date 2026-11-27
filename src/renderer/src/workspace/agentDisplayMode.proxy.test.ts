import { describe, expect, it } from 'vitest'

import { shouldUseProxyForSession } from './agentDisplayMode'

describe('shouldUseProxyForSession', () => {
  it('returns undefined for non-agent session kinds', () => {
    expect(
      shouldUseProxyForSession({
        kind: 'terminal',
        useProxyStreaming: true,
        globalMode: 'agent',
      }),
    ).toBeUndefined()
  })

  it('returns false when useProxyStreaming setting is disabled', () => {
    expect(
      shouldUseProxyForSession({
        kind: 'claude',
        useProxyStreaming: false,
        globalMode: 'agent',
      }),
    ).toBe(false)
  })

  it('returns false for Claude and Codex panes in hard terminal mode (global or override)', () => {
    expect(
      shouldUseProxyForSession({
        kind: 'claude',
        useProxyStreaming: true,
        globalMode: 'terminal',
      }),
    ).toBe(false)
    expect(
      shouldUseProxyForSession({
        kind: 'codex',
        useProxyStreaming: true,
        globalMode: 'terminal',
      }),
    ).toBe(false)
    expect(
      shouldUseProxyForSession({
        kind: 'claude',
        useProxyStreaming: true,
        globalMode: 'agent',
        override: 'terminal',
      }),
    ).toBe(false)
  })

  it('returns true for agent and hybrid modes, including per-pane override over global terminal', () => {
    expect(
      shouldUseProxyForSession({
        kind: 'claude',
        useProxyStreaming: true,
        globalMode: 'agent',
      }),
    ).toBe(true)
    expect(
      shouldUseProxyForSession({
        kind: 'codex',
        useProxyStreaming: true,
        globalMode: 'hybrid',
      }),
    ).toBe(true)
    expect(
      shouldUseProxyForSession({
        kind: 'claude',
        useProxyStreaming: true,
        globalMode: 'terminal',
        override: 'agent',
      }),
    ).toBe(true)
  })
})
