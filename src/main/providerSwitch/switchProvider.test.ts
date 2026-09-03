import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sourceRead: vi.fn(),
  targetProject: vi.fn(),
  targetWrite: vi.fn(),
  targetSessionId: vi.fn(),
  targetProfile: vi.fn(),
}))

vi.mock('node:crypto', () => ({
  randomUUID: () => '00000000-0000-4000-8000-000000000099',
}))

vi.mock('@main/providerSwitch/transcriptEngine.js', () => ({
  getHostTranscriptAdapter(provider: string) {
    if (provider === 'claude') {
      return {
        provider,
        read: mocks.sourceRead,
        projectNativeResume: vi.fn(),
        write: vi.fn(),
        sessionId: vi.fn(),
      }
    }
    if (provider === 'codex') {
      return {
        provider,
        read: vi.fn(),
        projectNativeResume: mocks.targetProject,
        write: mocks.targetWrite,
        sessionId: mocks.targetSessionId,
        targetProfile: mocks.targetProfile,
      }
    }
    if (provider === 'opencode') {
      return {
        provider,
        read: mocks.sourceRead,
        projectNativeResume: mocks.targetProject,
        write: mocks.targetWrite,
        sessionId: mocks.targetSessionId,
        targetProfile: mocks.targetProfile,
      }
    }
    throw new Error(`No transcript engine adapter is registered for provider "${provider}".`)
  },
}))

import { switchProvider } from './switchProvider.js'

const conversation = {
  schemaVersion: 1 as const,
  sourceProvider: 'claude',
  sourceSessionIds: ['source-session'],
  entries: [{
    kind: 'message' as const,
    role: 'user' as const,
    content: [{ kind: 'text' as const, text: 'hello' }],
    timestamp: '2026-07-20T12:00:00.000Z',
    source: { provider: 'claude', line: 0, raw: {}, evidence: [] },
  }],
}

const projection = {
  profile: 'native-resume' as const,
  targetProvider: 'codex',
  providerProfile: { id: 'test', provider: 'codex', evidence: {} },
  values: [{ type: 'session_meta', payload: { id: 'target-session' } }],
  report: {
    profile: 'native-resume' as const,
    sourceProvider: 'claude',
    targetProvider: 'codex',
    changes: [],
    counts: {
      preserved: 0,
      dropped: 0,
      demoted: 0,
      synthesized: 0,
      repaired: 0,
      retargeted: 0,
      opaque: 0,
    },
  },
}

describe('switchProvider neutral hub integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.sourceRead.mockResolvedValue(conversation)
    mocks.targetProject.mockResolvedValue(projection)
    mocks.targetSessionId.mockReturnValue('target-session')
    mocks.targetWrite.mockResolvedValue('/target/rollout.jsonl')
    mocks.targetProfile.mockResolvedValue({
      model: 'gpt-current',
      modelProvider: 'openai',
      budgetCharacters: 1_000,
    })
  })

  it('composes source and target adapters without selecting a provider pair translator', async () => {
    const result = await switchProvider({
      sourceKind: 'claude',
      targetKind: 'codex',
      sourceProviderSessionId: 'source-session',
      cwd: '/default',
      sourceCwd: '/source',
      targetCwd: '/target',
    })

    expect(mocks.sourceRead).toHaveBeenCalledWith('/source', 'source-session')
    expect(mocks.targetProfile).toHaveBeenCalledWith('/target')
    expect(mocks.targetProject).toHaveBeenCalledWith(
      conversation,
      expect.objectContaining({
        cwd: '/target',
        targetSessionId: '00000000-0000-4000-8000-000000000099',
      }),
    )
    expect(mocks.targetWrite).toHaveBeenCalledWith('/target', projection.values)
    expect(result).toEqual({
      kind: 'switched',
      targetKind: 'codex',
      targetProviderSessionId: 'target-session',
      targetFilePath: '/target/rollout.jsonl',
      compactedBeforeSwitch: false,
      truncatedBeforeSwitch: false,
    })
  })

  it.each([
    ['claude', 'opencode'],
    ['opencode', 'codex'],
  ] as const)('routes the %s → %s edge through the same neutral hub', async (sourceKind, targetKind) => {
    const result = await switchProvider({
      sourceKind,
      targetKind,
      sourceProviderSessionId: 'source-session',
      cwd: '/project',
    })

    expect(mocks.sourceRead).toHaveBeenCalledWith('/project', 'source-session')
    expect(mocks.targetProject).toHaveBeenCalledOnce()
    expect(mocks.targetWrite).toHaveBeenCalledOnce()
    expect(result.targetKind).toBe(targetKind)
  })

  it('runs native source compaction and retries planning before projection', async () => {
    const oversized = {
      ...conversation,
      entries: [{
        ...conversation.entries[0],
        content: [{ kind: 'text' as const, text: 'large '.repeat(300) }],
      }],
    }
    const compacted = {
      ...conversation,
      entries: [{
        kind: 'compaction' as const,
        summary: 'native summary',
        timestamp: null,
        source: { provider: 'claude', line: 10, raw: {}, evidence: [] },
      }, conversation.entries[0]],
    }
    const compactSource = vi.fn(async () => undefined)
    const onProgress = vi.fn()
    mocks.sourceRead
      .mockResolvedValueOnce(oversized)
      .mockResolvedValueOnce(compacted)

    const result = await switchProvider({
      sourceKind: 'claude',
      targetKind: 'codex',
      sourceProviderSessionId: 'source-session',
      sourceSessionId: 'local-session',
      cwd: '/project',
    }, { compactSource, onProgress })

    expect(compactSource).toHaveBeenCalledOnce()
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'compacting' }))
    expect(mocks.targetProject).toHaveBeenCalledWith(
      compacted,
      expect.objectContaining({
        targetProfile: expect.objectContaining({ model: 'gpt-current' }),
      }),
    )
    expect(result.kind).toBe('switched')
    if (result.kind !== 'switched') throw new Error('expected a translated target session')
    expect(result.compactedBeforeSwitch).toBe(true)
    expect(result.truncatedBeforeSwitch).toBe(false)
  })

  it('reports a durable but empty source without writing a target transcript', async () => {
    mocks.sourceRead.mockResolvedValueOnce({
      ...conversation,
      entries: [],
    })

    await expect(switchProvider({
      sourceKind: 'opencode',
      targetKind: 'claude',
      sourceProviderSessionId: 'ses_precreated_but_empty',
      cwd: '/project',
    })).resolves.toEqual({
      kind: 'source-empty',
      targetKind: 'claude',
    })

    expect(mocks.targetProfile).not.toHaveBeenCalled()
    expect(mocks.targetProject).not.toHaveBeenCalled()
    expect(mocks.targetWrite).not.toHaveBeenCalled()
  })

  it('never truncates overflow unless the caller explicitly requests it', async () => {
    mocks.sourceRead.mockResolvedValueOnce({
      ...conversation,
      entries: [{
        ...conversation.entries[0],
        content: [{ kind: 'text' as const, text: 'large '.repeat(300) }],
      }],
    })

    await expect(switchProvider({
      sourceKind: 'claude',
      targetKind: 'codex',
      sourceProviderSessionId: 'source-session',
      cwd: '/project',
      overflowPolicy: 'fail',
    })).rejects.toThrow('requires compaction')
    expect(mocks.targetProject).not.toHaveBeenCalled()
    expect(mocks.targetWrite).not.toHaveBeenCalled()
  })

  it('does not write a target file when projection fails', async () => {
    mocks.targetProject.mockRejectedValueOnce(new Error('profile rejected'))
    await expect(switchProvider({
      sourceKind: 'claude',
      targetKind: 'codex',
      sourceProviderSessionId: 'source-session',
      cwd: '/project',
    })).rejects.toThrow('profile rejected')
    expect(mocks.targetWrite).not.toHaveBeenCalled()
  })

  it('requires an explicit target for providers outside the legacy pair', async () => {
    await expect(switchProvider({
      sourceKind: 'opencode',
      sourceProviderSessionId: 'source-session',
      cwd: '/project',
    })).rejects.toThrow('targetKind is required')
  })
})
