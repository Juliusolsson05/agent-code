import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  listPrompts: vi.fn(),
  draft: vi.fn(),
  project: vi.fn(),
  write: vi.fn(),
  sessionId: vi.fn(),
}))

vi.mock('node:crypto', () => ({
  randomUUID: () => '00000000-0000-4000-8000-000000000097',
}))

vi.mock('@main/providerSwitch/transcriptEngine.js', () => ({
  getHostTranscriptAdapter(provider: string) {
    if (provider === 'opencode') throw new Error('No transcript engine adapter is registered')
    return {
      provider,
      read: mocks.read,
      listPrompts: mocks.listPrompts,
      draft: mocks.draft,
      projectNativeResume: mocks.project,
      write: mocks.write,
      sessionId: mocks.sessionId,
    }
  },
}))

import { listRewindPrompts, rewindSession } from './rewindSession.js'

const sourceConversation = {
  schemaVersion: 1 as const,
  sourceProvider: 'codex',
  sourceSessionIds: ['source-session'],
  entries: [
    {
      kind: 'message' as const,
      role: 'user' as const,
      content: [{ kind: 'text' as const, text: 'first' }],
      timestamp: '2026-07-20T10:00:00.000Z',
      source: { provider: 'codex', line: 2, raw: {}, evidence: [] },
    },
    {
      kind: 'message' as const,
      role: 'assistant' as const,
      content: [{ kind: 'text' as const, text: 'answer' }],
      timestamp: '2026-07-20T10:00:01.000Z',
      source: { provider: 'codex', line: 3, raw: {}, evidence: [] },
    },
    {
      kind: 'message' as const,
      role: 'user' as const,
      content: [{ kind: 'text' as const, text: 'second' }],
      timestamp: '2026-07-20T10:00:02.000Z',
      source: { provider: 'codex', line: 7, raw: {}, evidence: [] },
    },
  ],
}

describe('rewindSession neutral integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.read.mockResolvedValue(sourceConversation)
    mocks.draft.mockReturnValue({
      promptText: 'second',
      promptMode: 'prompt',
      promptImages: [],
    })
    mocks.project.mockResolvedValue({ values: [{ type: 'session_meta' }] })
    mocks.sessionId.mockReturnValue('new-session')
    mocks.write.mockResolvedValue('/target/rollout.jsonl')
  })

  it('uses an exact source address and writes only the projected semantic prefix', async () => {
    const result = await rewindSession({
      provider: 'codex',
      sourceProviderSessionId: 'source-session',
      cwd: '/project',
      anchor: { provider: 'codex', line: 7, sessionId: 'source-session' },
    })

    expect(mocks.project).toHaveBeenCalledWith(
      expect.objectContaining({ entries: sourceConversation.entries.slice(0, 2) }),
      expect.objectContaining({
        cwd: '/project',
        targetSessionId: '00000000-0000-4000-8000-000000000097',
      }),
    )
    expect(mocks.write).toHaveBeenCalledOnce()
    expect(result).toMatchObject({
      newProviderSessionId: 'new-session',
      promptText: 'second',
      promptTimestamp: '2026-07-20T10:00:02.000Z',
    })
  })

  it('returns analyzed prompts newest-first and caps the IPC payload', async () => {
    mocks.listPrompts.mockResolvedValue([
      { address: { provider: 'codex', line: 2, sessionId: 'source-session' }, text: 'first', timestamp: null },
      { address: { provider: 'codex', line: 7, sessionId: 'source-session' }, text: 'second', timestamp: null },
    ])
    await expect(listRewindPrompts({
      provider: 'codex',
      sourceProviderSessionId: 'source-session',
      cwd: '/project',
      limit: 1,
    })).resolves.toEqual([
      { address: { provider: 'codex', line: 7, sessionId: 'source-session' }, text: 'second', timestamp: null },
    ])
  })

  it('rejects a cross-provider address before reading or writing', async () => {
    await expect(rewindSession({
      provider: 'codex',
      sourceProviderSessionId: 'source-session',
      cwd: '/project',
      anchor: { provider: 'claude', line: 7, sessionId: 'source-session', uuid: 'prompt' },
    })).rejects.toThrow('Rewind address is for claude, not codex')
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('does not write when native projection fails', async () => {
    mocks.project.mockRejectedValueOnce(new Error('profile rejected'))
    await expect(rewindSession({
      provider: 'codex',
      sourceProviderSessionId: 'source-session',
      cwd: '/project',
      anchor: { provider: 'codex', line: 7, sessionId: 'source-session' },
    })).rejects.toThrow('profile rejected')
    expect(mocks.write).not.toHaveBeenCalled()
  })
})
