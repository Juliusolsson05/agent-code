import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  sourceRead: vi.fn(),
  targetProject: vi.fn(),
  targetWrite: vi.fn(),
  targetSessionId: vi.fn(),
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
    expect(mocks.targetProject).toHaveBeenCalledWith(
      conversation,
      expect.objectContaining({
        cwd: '/target',
        targetSessionId: '00000000-0000-4000-8000-000000000099',
      }),
    )
    expect(mocks.targetWrite).toHaveBeenCalledWith('/target', projection.values)
    expect(result).toEqual({
      targetKind: 'codex',
      targetProviderSessionId: 'target-session',
      targetFilePath: '/target/rollout.jsonl',
    })
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
