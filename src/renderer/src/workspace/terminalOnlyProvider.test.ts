import { describe, expect, it } from 'vitest'

import { commandAllowedByRenderedViewPolicy, getEffectiveAgentSurface } from '@renderer/workspace/agentDisplayMode'
import { AGENT_PROVIDER_CHOICES } from '@renderer/workspace/providerChoices'
import { emptyRuntime } from '@renderer/session-runtime/state'
import {
  AGENT_PROVIDER_KINDS,
  effectiveProviderRuntime,
  isTerminalOnlyProviderKind,
  providerOffersTerminalRuntime,
  type AgentProviderRuntime,
} from '@shared/types/providerKind'

// Pi is terminal-only (spec docs/decomposition/pi-terminal.md §5.1): its pane
// must be pi's own TUI from EVERY spawn path. Those paths disagree on what
// they store — the new-agent picker stamps `providerRuntime: 'terminal'`,
// while the conversation catalog's resume, split chords, a provider switch
// (which drops the runtime when the kind changes), MCP create_agent without a
// runtime and the control API store nothing, and a workspace saved before Pi
// existed obviously stored nothing either. The read-time resolution is what
// makes all of them agree; each row below is one of those stored shapes.

const STORED_RUNTIMES: Array<{ path: string; runtime: AgentProviderRuntime | undefined }> = [
  { path: 'new-agent picker / New Agent In (choice carries the runtime)', runtime: 'terminal' },
  { path: 'catalog resume, split chord, provider switch, MCP create_agent, control API (kind only)', runtime: undefined },
]

const MODES = ['agent', 'hybrid', 'terminal'] as const

function busyRenderedRuntime() {
  // Every runtime field that would promote Hybrid to the rendered surface for
  // an ordinary agent — a Pi pane must stay on its TUI regardless.
  return { ...emptyRuntime(), draftInput: 'draft', queuedMessages: [{ id: 'q', text: 'queued' }] as never, renderedViewLeases: { copy: 1 } as never }
}

describe('terminal-only providers (Pi)', () => {
  it('Pi is the terminal-only provider, and only terminal-only kinds are pinned', () => {
    expect(AGENT_PROVIDER_KINDS.filter(isTerminalOnlyProviderKind)).toEqual(['pi'])
  })

  for (const { path, runtime } of STORED_RUNTIMES) {
    for (const mode of MODES) {
      it(`${path} · ${mode} mode → the TUI surface`, () => {
        expect(effectiveProviderRuntime('pi', runtime)).toBe('terminal')
        expect(getEffectiveAgentSurface({ kind: 'pi', providerRuntime: runtime, mode, runtime: busyRenderedRuntime() })).toBe('terminal')
      })
    }
    it(`${path} → rendered-feed commands are hidden`, () => {
      for (const policy of [{ kind: 'requires-rendered-feed' }, { kind: 'opens-rendered-feed' }, { kind: 'leases-rendered-feed', feature: 'copy' }] as const) {
        expect(commandAllowedByRenderedViewPolicy({ policy: policy as never, kind: 'pi', providerRuntime: runtime, mode: 'agent', runtime: emptyRuntime() })).toBe(false)
      }
    })
  }

  it('the picker offers Pi only as its terminal runtime', () => {
    expect(AGENT_PROVIDER_CHOICES.filter(choice => choice.kind === 'pi')).toEqual([
      expect.objectContaining({ kind: 'pi', label: 'Pi', providerRuntime: 'terminal' }),
    ])
  })

  it('may request the terminal runtime for Pi and OpenCode only', () => {
    expect(AGENT_PROVIDER_KINDS.filter(providerOffersTerminalRuntime)).toEqual(['opencode', 'pi'])
  })

  // Regression guards: the helper must not change anything for providers
  // that are not terminal-only.
  it('leaves OpenCode’s two runtimes and every other provider exactly as stored', () => {
    expect(effectiveProviderRuntime('opencode', undefined)).toBeUndefined()
    expect(effectiveProviderRuntime('opencode', 'terminal')).toBe('terminal')
    expect(effectiveProviderRuntime('claude', undefined)).toBeUndefined()
    expect(effectiveProviderRuntime('terminal', undefined)).toBeUndefined()
    expect(getEffectiveAgentSurface({ kind: 'opencode', mode: 'terminal', runtime: emptyRuntime() })).toBe('rendered')
    expect(getEffectiveAgentSurface({ kind: 'opencode', providerRuntime: 'terminal', mode: 'agent', runtime: emptyRuntime() })).toBe('terminal')
    expect(getEffectiveAgentSurface({ kind: 'claude', mode: 'agent', runtime: emptyRuntime() })).toBe('rendered')
  })
})
