import { describe, expect, it } from 'vitest'

import {
  commandAllowedByRenderedViewPolicy,
  getEffectiveAgentSurface,
} from '@renderer/workspace/agentDisplayMode'
import { emptyRuntime } from '@renderer/workspace/workspaceState'

describe('agent display mode policy', () => {
  it('keeps Agent mode on the rendered surface even without leases', () => {
    expect(
      getEffectiveAgentSurface({
        kind: 'claude',
        mode: 'agent',
        runtime: emptyRuntime(),
      }),
    ).toBe('rendered')
  })

  it('keeps hard Terminal mode on the raw terminal even when a lease exists', () => {
    const runtime = {
      ...emptyRuntime(),
      renderedViewLeases: { 'copy-assistant-message': 1 },
    }

    expect(
      getEffectiveAgentSurface({
        kind: 'codex',
        mode: 'terminal',
        runtime,
      }),
    ).toBe('terminal')
  })

  it('uses Hybrid as terminal-first, rendered only while leases are active', () => {
    expect(
      getEffectiveAgentSurface({
        kind: 'claude',
        mode: 'hybrid',
        runtime: emptyRuntime(),
      }),
    ).toBe('terminal')

    expect(
      getEffectiveAgentSurface({
        kind: 'claude',
        mode: 'hybrid',
        runtime: {
          ...emptyRuntime(),
          renderedViewLeases: { 'copy-assistant-message': 1 },
        },
      }),
    ).toBe('rendered')
  })

  it('uses rendered-only runtime state to wake Hybrid', () => {
    const cases = [
      { draftInput: 'prefilled prompt' },
      { draftImages: [{ id: 'img', mediaType: 'image/png', base64Data: 'x', previewUrl: 'blob:x', filename: 'x.png' }] },
      { promptSuggestion: { text: 'try this next', receivedAt: 1 } },
      { conditions: { kind: 'approval', prompts: [] } as never },
      { queuedMessages: [{ content: 'queued', timestamp: '2026-06-23T00:00:00.000Z' }] },
    ]

    for (const patch of cases) {
      expect(
        getEffectiveAgentSurface({
          kind: 'claude',
          mode: 'hybrid',
          runtime: { ...emptyRuntime(), ...patch },
        }),
      ).toBe('rendered')
    }
  })

  it('allows leasing commands in Hybrid but not hard Terminal mode', () => {
    const policy = {
      kind: 'leases-rendered-feed' as const,
      feature: 'copy-assistant-message' as const,
    }

    expect(
      commandAllowedByRenderedViewPolicy({
        policy,
        kind: 'claude',
        mode: 'hybrid',
        runtime: emptyRuntime(),
      }),
    ).toBe(true)

    expect(
      commandAllowedByRenderedViewPolicy({
        policy,
        kind: 'claude',
        mode: 'terminal',
        runtime: emptyRuntime(),
      }),
    ).toBe(false)
  })

  it('allows commands that open rendered state in Hybrid but not hard Terminal mode', () => {
    expect(
      commandAllowedByRenderedViewPolicy({
        policy: { kind: 'opens-rendered-feed' },
        kind: 'codex',
        mode: 'hybrid',
        runtime: emptyRuntime(),
      }),
    ).toBe(true)

    expect(
      commandAllowedByRenderedViewPolicy({
        policy: { kind: 'opens-rendered-feed' },
        kind: 'codex',
        mode: 'terminal',
        runtime: emptyRuntime(),
      }),
    ).toBe(false)
  })

  it('allows render-required commands in Hybrid only after another lease renders the pane', () => {
    expect(
      commandAllowedByRenderedViewPolicy({
        policy: { kind: 'requires-rendered-feed' },
        kind: 'claude',
        mode: 'hybrid',
        runtime: emptyRuntime(),
      }),
    ).toBe(false)

    expect(
      commandAllowedByRenderedViewPolicy({
        policy: { kind: 'requires-rendered-feed' },
        kind: 'claude',
        mode: 'hybrid',
        runtime: {
          ...emptyRuntime(),
          renderedViewLeases: { 'copy-assistant-message': 1 },
        },
      }),
    ).toBe(true)
  })
})
