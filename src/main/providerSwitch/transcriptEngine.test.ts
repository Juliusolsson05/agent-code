import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
}))

vi.mock('fs/promises', () => ({ readFile: mocks.readFile }))
vi.mock('@main/providerSwitch/shared.js', () => ({
  findCodexRolloutPathBySessionId: vi.fn(async () => '/codex/source.jsonl'),
  getClaudeSessionFilePath: vi.fn(async () => '/claude/source.jsonl'),
  projectedClaudeSessionId: vi.fn(),
  projectedCodexSessionMeta: vi.fn(),
  writeProjectedClaudeSessionFile: vi.fn(),
  writeProjectedCodexRolloutFile: vi.fn(),
}))
vi.mock('@main/setup/cliVersion.js', () => ({
  readInstalledVersion: vi.fn(async () => ({ ok: true, version: 'test' })),
}))
vi.mock('@main/setup/toolchain.js', () => ({ getToolPath: vi.fn(() => '/tool') }))

import { getHostTranscriptAdapter } from './transcriptEngine.js'

describe('host transcript adapter registry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('registers providers independently of conversion pairs', () => {
    expect(getHostTranscriptAdapter('claude').provider).toBe('claude')
    expect(getHostTranscriptAdapter('codex').provider).toBe('codex')
  })

  it('fails before IO when a provider has no transcript adapter', () => {
    expect(() => getHostTranscriptAdapter('opencode')).toThrow(
      'No transcript engine adapter is registered',
    )
  })

  it('returns exact Codex source addresses instead of renderer ordinals', async () => {
    mocks.readFile.mockResolvedValue([
      jsonl({ type: 'session_meta', payload: { id: 'session', timestamp: '2026-07-20T10:00:00.000Z' } }),
      jsonl({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'duplicate text' }] } }),
      jsonl({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] } }),
      jsonl({ type: 'event_msg', payload: { type: 'user_message', message: 'duplicate text' } }),
      jsonl({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'duplicate text' }] } }),
    ].join('\n'))

    await expect(getHostTranscriptAdapter('codex').listPrompts('/project', 'session'))
      .resolves.toEqual([{
        address: { provider: 'codex', line: 4, sessionId: 'session' },
        text: 'duplicate text',
        timestamp: null,
      }])
  })
})

function jsonl(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}
