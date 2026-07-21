import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ read: vi.fn() }))

vi.mock('@main/providerSwitch/transcriptEngine.js', () => ({
  getHostTranscriptAdapter: () => ({ read: mocks.read }),
}))

import { compactSourceBeforeSwitch } from './compactBeforeSwitch.js'

describe('compactSourceBeforeSwitch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns only after the live provider persists a new native summary', async () => {
    mocks.read
      .mockResolvedValueOnce(conversation([]))
      .mockResolvedValueOnce(conversation([compaction('provider-authored summary', 12)]))
    const manager = {
      getSessionKind: vi.fn(() => 'claude'),
      getSpawnCwd: vi.fn(() => '/project'),
      deliverPromptToAgent: vi.fn(async () => ({ ok: true })),
    }

    await compactSourceBeforeSwitch(manager as never, {
      sourceKind: 'claude',
      targetKind: 'codex',
      sourceProviderSessionId: 'provider-session',
      sourceSessionId: 'local-session',
      cwd: '/project',
    })

    expect(manager.deliverPromptToAgent).toHaveBeenCalledWith('local-session', '/compact')
    expect(mocks.read).toHaveBeenCalledTimes(2)
  })

  it('does not retry when the provider rejects the compaction command', async () => {
    mocks.read.mockResolvedValueOnce(conversation([]))
    const manager = {
      getSessionKind: vi.fn(() => 'codex'),
      getSpawnCwd: vi.fn(() => '/project'),
      deliverPromptToAgent: vi.fn(async () => ({
        ok: false,
        message: 'composer unavailable',
      })),
    }

    await expect(compactSourceBeforeSwitch(manager as never, {
      sourceKind: 'codex',
      targetKind: 'claude',
      sourceProviderSessionId: 'provider-session',
      sourceSessionId: 'local-session',
      cwd: '/project',
    })).rejects.toThrow('composer unavailable')
    expect(mocks.read).toHaveBeenCalledOnce()
  })

  it('asks compacted Codex for a plaintext handoff instead of copying encrypted compaction', async () => {
    mocks.read
      .mockResolvedValueOnce(conversation([]))
      .mockResolvedValueOnce(conversation([compaction('', 12)]))
      .mockResolvedValueOnce(conversation([
        compaction('', 12),
        assistant('portable work summary', 14),
      ]))
    const manager = {
      getSessionKind: vi.fn(() => 'codex'),
      getSpawnCwd: vi.fn(() => '/project'),
      deliverPromptToAgent: vi.fn(async () => ({ ok: true })),
    }

    const result = await compactSourceBeforeSwitch(manager as never, {
      sourceKind: 'codex',
      targetKind: 'claude',
      sourceProviderSessionId: 'provider-session',
      sourceSessionId: 'local-session',
      cwd: '/project',
    })

    expect(manager.deliverPromptToAgent).toHaveBeenCalledTimes(2)
    expect(manager.deliverPromptToAgent).toHaveBeenNthCalledWith(1, 'local-session', '/compact')
    expect(manager.deliverPromptToAgent).toHaveBeenNthCalledWith(
      2,
      'local-session',
      expect.stringContaining('portable handoff summary'),
    )
    expect(result.entries).toEqual([expect.objectContaining({
      kind: 'compaction',
      summary: 'portable work summary',
    })])
  })
})

function conversation(entries: Array<ReturnType<typeof compaction> | ReturnType<typeof assistant>>) {
  return {
    schemaVersion: 1 as const,
    sourceProvider: 'claude',
    sourceSessionIds: ['provider-session'],
    entries,
  }
}

function assistant(text: string, line: number) {
  return {
    kind: 'message' as const,
    role: 'assistant' as const,
    content: [{ kind: 'text' as const, text }],
    timestamp: null,
    source: { provider: 'codex', line, raw: {}, evidence: [] },
  }
}

function compaction(summary: string, line: number) {
  return {
    kind: 'compaction' as const,
    summary,
    timestamp: null,
    source: { provider: 'claude', line, raw: {}, evidence: [] },
  }
}
