import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  project: vi.fn(),
  write: vi.fn(),
  sessionId: vi.fn(),
}))

vi.mock('node:crypto', () => ({
  randomUUID: () => '00000000-0000-4000-8000-000000000848',
}))

vi.mock('@main/providerSwitch/transcriptEngine.js', () => ({
  getHostTranscriptAdapter(provider: string) {
    if (provider !== 'codex') throw new Error('No transcript engine adapter is registered')
    return {
      provider,
      read: mocks.read,
      projectNativeResume: mocks.project,
      write: mocks.write,
      sessionId: mocks.sessionId,
    }
  },
}))

import { stripCodexCyberPolicy } from './stripCodexCyberPolicy.js'

const sourceConversation = {
  schemaVersion: 1 as const,
  sourceProvider: 'codex' as const,
  sourceSessionIds: ['source-session'],
  entries: [
    {
      kind: 'message' as const,
      role: 'user' as const,
      content: [{ kind: 'text' as const, text: 'build it' }],
      timestamp: '2026-09-10T00:00:01.000Z',
      source: { provider: 'codex', line: 1, raw: {}, evidence: [] },
    },
    {
      kind: 'message' as const,
      role: 'assistant' as const,
      content: [{ kind: 'text' as const, text: 'working' }],
      timestamp: '2026-09-10T00:00:02.000Z',
      source: { provider: 'codex', line: 2, raw: {}, evidence: [] },
    },
    {
      kind: 'tool-call' as const,
      callId: 'call-kept',
      name: 'exec',
      input: { cmd: 'ls' },
      nativeKind: 'custom_tool_call',
      timestamp: '2026-09-10T00:00:03.000Z',
      source: { provider: 'codex', line: 3, raw: {}, evidence: [] },
    },
    {
      kind: 'tool-result' as const,
      callId: 'call-kept',
      output: 'ok',
      isError: null,
      nativeKind: 'custom_tool_call_output',
      timestamp: '2026-09-10T00:00:04.000Z',
      source: { provider: 'codex', line: 4, raw: {}, evidence: [] },
    },
    {
      kind: 'tool-call' as const,
      callId: 'call-last',
      name: 'exec',
      input: { cmd: 'rg' },
      nativeKind: 'custom_tool_call',
      timestamp: '2026-09-10T00:00:05.000Z',
      source: { provider: 'codex', line: 5, raw: {}, evidence: [] },
    },
    {
      kind: 'tool-result' as const,
      callId: 'call-last',
      output: 'flagged-input',
      isError: null,
      nativeKind: 'custom_tool_call_output',
      timestamp: '2026-09-10T00:00:06.000Z',
      source: { provider: 'codex', line: 6, raw: {}, evidence: [] },
    },
    {
      kind: 'opaque' as const,
      nativeType: 'event_msg',
      timestamp: '2026-09-10T00:00:07.000Z',
      source: {
        provider: 'codex',
        line: 7,
        raw: {
          type: 'event_msg',
          payload: {
            type: 'task_complete',
            error: { codex_error_info: 'cyber_policy', message: 'flagged' },
          },
        },
        evidence: [],
      },
    },
  ],
}

describe('stripCodexCyberPolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.read.mockResolvedValue(sourceConversation)
    mocks.project.mockResolvedValue({ values: [{ type: 'session_meta' }] })
    mocks.sessionId.mockReturnValue('new-session')
    mocks.write.mockResolvedValue('/target/rollout.jsonl')
  })

  it('projects the conversation with the last model step removed and writes only then', async () => {
    const result = await stripCodexCyberPolicy({
      provider: 'codex',
      sourceProviderSessionId: 'source-session',
      cwd: '/project',
    })

    expect(mocks.project).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: sourceConversation.entries.slice(0, 4),
      }),
      expect.objectContaining({
        cwd: '/project',
        targetSessionId: '00000000-0000-4000-8000-000000000848',
      }),
    )
    expect(mocks.write).toHaveBeenCalledOnce()
    expect(result).toEqual({
      provider: 'codex',
      newProviderSessionId: 'new-session',
      newFilePath: '/target/rollout.jsonl',
    })
  })

  it('rejects a non-Codex provider before reading', async () => {
    await expect(stripCodexCyberPolicy({
      provider: 'claude',
      sourceProviderSessionId: 'source-session',
      cwd: '/project',
    })).rejects.toThrow(/Codex/)
    expect(mocks.read).not.toHaveBeenCalled()
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('does not write when the session has no cyber policy block', async () => {
    mocks.read.mockResolvedValueOnce({
      ...sourceConversation,
      entries: sourceConversation.entries.slice(0, 2),
    })
    await expect(stripCodexCyberPolicy({
      provider: 'codex',
      sourceProviderSessionId: 'source-session',
      cwd: '/project',
    })).rejects.toThrow(/No cybersecurity block/)
    expect(mocks.write).not.toHaveBeenCalled()
  })

  it('does not write when native projection fails', async () => {
    mocks.project.mockRejectedValueOnce(new Error('profile rejected'))
    await expect(stripCodexCyberPolicy({
      provider: 'codex',
      sourceProviderSessionId: 'source-session',
      cwd: '/project',
    })).rejects.toThrow('profile rejected')
    expect(mocks.write).not.toHaveBeenCalled()
  })
})
