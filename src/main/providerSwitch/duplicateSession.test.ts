import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  project: vi.fn(),
  write: vi.fn(),
  sessionId: vi.fn(),
  sourceProfile: vi.fn(),
}))

vi.mock('node:crypto', () => ({
  randomUUID: () => '00000000-0000-4000-8000-000000000098',
}))

vi.mock('@main/providerSwitch/transcriptEngine.js', () => ({
  getHostTranscriptAdapter(provider: string) {
    if (provider === 'unknown') throw new Error('No transcript engine adapter is registered')
    return {
      provider,
      read: mocks.read,
      projectNativeResume: mocks.project,
      write: mocks.write,
      sessionId: mocks.sessionId,
      sourceProfile: mocks.sourceProfile,
    }
  },
}))

import { duplicateSession } from './duplicateSession.js'
import { projectGrokNativeResume } from 'agent-transcript-parser'

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
    expect(mocks.write).toHaveBeenCalledWith('/target', { values: [{ sessionId: 'new-session' }] })
    expect(result).toEqual({
      provider: 'claude',
      newProviderSessionId: 'new-session',
      newFilePath: '/target/new-session.jsonl',
    })
  })

  it('fails before reading when the provider has no adapter', async () => {
    await expect(duplicateSession({
      provider: 'unknown' as 'claude',
      sourceProviderSessionId: 'source',
      cwd: '/project',
    })).rejects.toThrow('No transcript engine adapter')
    expect(mocks.read).not.toHaveBeenCalled()
  })

  it('passes a complete native projection including sidecars to identity and storage adapters', async () => {
    // The orchestration is provider-neutral: exercise the real Grok projector
    // through the controlled adapter boundary before Grok UI registration.
    const projection = projectGrokNativeResume(conversation, {
      cwd: '/target', targetSessionId: '00000000-0000-4000-8000-000000000098',
      now: '2026-09-08T00:00:00.000Z', model: 'fixture-model',
    })
    mocks.project.mockResolvedValue(projection)
    await duplicateSession({ provider: 'claude', sourceProviderSessionId: 'source', cwd: '/target' })
    expect(mocks.sessionId).toHaveBeenCalledWith(projection)
    expect(mocks.write).toHaveBeenCalledWith('/target', projection)
  })

  it('duplicates an empty OpenCode export because blank sessions are native import values', async () => {
    mocks.read.mockResolvedValue({
      schemaVersion: 1,
      sourceProvider: 'opencode',
      sourceSessionIds: ['source'],
      entries: [],
    })

    const result = await duplicateSession({
      provider: 'opencode',
      sourceProviderSessionId: 'source',
      cwd: '/project',
    })

    expect(mocks.project).toHaveBeenCalledWith(
      expect.objectContaining({ entries: [] }),
      expect.objectContaining({ cwd: '/project' }),
    )
    expect(result.newProviderSessionId).toBe('new-session')
  })
})

// #1038. A duplicate is the same conversation continuing, so it keeps the
// model it ran on; the machine's current default may be something the user
// switched to long afterwards, in another pane.
describe('duplicate keeps the source conversation\'s own model', () => {
  beforeEach(() => {
    // Call history from the suites above would otherwise be inspected here.
    for (const mock of Object.values(mocks)) mock.mockReset()
    mocks.read.mockResolvedValue({ entries: [{ kind: 'message', role: 'user' }], sourceSessionIds: ['ses_source'] })
    mocks.project.mockResolvedValue({ values: [{}] })
    mocks.write.mockResolvedValue('/fixture/new.json')
    mocks.sessionId.mockReturnValue('ses_new')
  })

  it('passes the recorded profile through as the projection target', async () => {
    const recorded = { model: 'glm-5.3', modelProvider: 'zai-coding-plan', modelVariant: 'max', budgetCharacters: 500_000 }
    mocks.sourceProfile.mockResolvedValue(recorded)
    await duplicateSession({ provider: 'opencode', sourceProviderSessionId: 'ses_source', cwd: '/fixture' })
    expect(mocks.sourceProfile).toHaveBeenCalledWith('/fixture', 'ses_source')
    expect(mocks.project.mock.calls[0]![1]).toMatchObject({ targetProfile: recorded })
  })

  it('falls back to the adapter default when the provider records no model, and when the read fails', async () => {
    // Claude and Codex have no sourceProfile at all; OpenCode can still fail
    // to export. Neither may block a duplicate — the projector then resolves
    // its own target profile, which is the pre-#1038 behaviour.
    mocks.sourceProfile.mockResolvedValue(null)
    await duplicateSession({ provider: 'opencode', sourceProviderSessionId: 'ses_source', cwd: '/fixture' })
    expect(mocks.project.mock.calls[0]![1].targetProfile).toBeUndefined()

    mocks.project.mockClear()
    mocks.sourceProfile.mockRejectedValue(new Error('opencode export failed'))
    await expect(duplicateSession({ provider: 'opencode', sourceProviderSessionId: 'ses_source', cwd: '/fixture' }))
      .resolves.toMatchObject({ newProviderSessionId: 'ses_new' })
    expect(mocks.project.mock.calls[0]![1].targetProfile).toBeUndefined()
  })
})
