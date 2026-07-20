import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  project: vi.fn(),
  write: vi.fn(),
  sessionId: vi.fn(),
}))

vi.mock('node:crypto', () => ({
  randomUUID: () => '00000000-0000-4000-8000-000000000098',
}))

vi.mock('@main/providerSwitch/transcriptEngine.js', () => ({
  getHostTranscriptAdapter(provider: string) {
    if (provider === 'opencode') throw new Error('No transcript engine adapter is registered')
    return {
      provider,
      read: mocks.read,
      projectNativeResume: mocks.project,
      write: mocks.write,
      sessionId: mocks.sessionId,
    }
  },
}))

import { duplicateSession } from './duplicateSession.js'

const conversation = {
  schemaVersion: 1 as const,
  sourceProvider: 'claude',
  sourceSessionIds: ['source'],
  entries: [{
    kind: 'message' as const,
    role: 'user' as const,
    content: [{ kind: 'text' as const, text: 'hello' }],
    timestamp: null,
    source: { provider: 'claude', line: 0, raw: {}, evidence: [] },
  }],
}

describe('duplicateSession neutral integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.read.mockResolvedValue(conversation)
    mocks.project.mockResolvedValue({ values: [{ sessionId: 'new-session' }] })
    mocks.sessionId.mockReturnValue('new-session')
    mocks.write.mockResolvedValue('/target/new-session.jsonl')
  })

  it('uses one provider adapter for decode, fresh projection, and storage', async () => {
    const result = await duplicateSession({
      provider: 'claude',
      sourceProviderSessionId: 'source',
      cwd: '/default',
      sourceCwd: '/source',
      targetCwd: '/target',
    })

    expect(mocks.read).toHaveBeenCalledWith('/source', 'source')
    expect(mocks.project).toHaveBeenCalledWith(
      conversation,
      expect.objectContaining({
        cwd: '/target',
        targetSessionId: '00000000-0000-4000-8000-000000000098',
      }),
    )
    expect(mocks.write).toHaveBeenCalledWith('/target', [{ sessionId: 'new-session' }])
    expect(result).toEqual({
      provider: 'claude',
      newProviderSessionId: 'new-session',
      newFilePath: '/target/new-session.jsonl',
    })
  })

  it('fails before reading when the provider has no adapter', async () => {
    await expect(duplicateSession({
      provider: 'opencode',
      sourceProviderSessionId: 'source',
      cwd: '/project',
    })).rejects.toThrow('No transcript engine adapter')
    expect(mocks.read).not.toHaveBeenCalled()
  })
})
