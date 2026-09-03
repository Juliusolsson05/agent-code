import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  exportOpencodeSession: vi.fn(),
  importOpencodeSession: vi.fn(),
  listOpencodeModels: vi.fn(),
  readResolvedOpencodeConfig: vi.fn(),
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
vi.mock('@providers/opencode/runtime/opencodeCliSessions.js', () => ({
  exportOpencodeSession: mocks.exportOpencodeSession,
  importOpencodeSession: mocks.importOpencodeSession,
  listOpencodeModels: mocks.listOpencodeModels,
  readResolvedOpencodeConfig: mocks.readResolvedOpencodeConfig,
  opencodeExportSessionId: (value: { info?: { id?: string } }) => value.info?.id,
}))

import { getHostTranscriptAdapter } from './transcriptEngine.js'

describe('host transcript adapter registry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.readResolvedOpencodeConfig.mockResolvedValue({ model: 'anthropic/claude-sonnet-4' })
    mocks.listOpencodeModels.mockResolvedValue([])
  })

  it('registers providers independently of conversion pairs', () => {
    expect(getHostTranscriptAdapter('claude').provider).toBe('claude')
    expect(getHostTranscriptAdapter('codex').provider).toBe('codex')
    expect(getHostTranscriptAdapter('opencode').provider).toBe('opencode')
  })

  it('decodes OpenCode exports and exposes exact message indexes as prompts', async () => {
    mocks.exportOpencodeSession.mockResolvedValue({
      info: { id: 'ses_source' },
      messages: [
        {
          info: { id: 'msg_1', sessionID: 'ses_source', role: 'user', time: { created: 1 } },
          parts: [{ type: 'text', text: 'first' }],
        },
        {
          info: {
            id: 'msg_2', sessionID: 'ses_source', role: 'assistant',
            time: { created: 2, completed: 3 },
          },
          parts: [{ type: 'text', text: 'answer' }],
        },
        {
          info: { id: 'msg_3', sessionID: 'ses_source', role: 'user', time: { created: 4 } },
          parts: [{ type: 'text', text: 'second' }],
        },
        {
          info: {
            id: 'msg_4', sessionID: 'ses_source', role: 'assistant',
            time: { created: 5, completed: 6 },
          },
          parts: [{ type: 'text', text: 'second answer' }],
        },
      ],
    })

    await expect(getHostTranscriptAdapter('opencode').read('/project', 'ses_source'))
      .resolves.toMatchObject({ sourceProvider: 'opencode', sourceSessionIds: ['ses_source'] })
    await expect(getHostTranscriptAdapter('opencode').listPrompts('/project', 'ses_source'))
      .resolves.toEqual([{
        address: { provider: 'opencode', line: 2, sessionId: 'ses_source' },
        text: 'second',
        timestamp: '1970-01-01T00:00:00.004Z',
      }])
  })

  it('uses OpenCode resolved provider/model metadata for capacity and projection', async () => {
    await expect(getHostTranscriptAdapter('opencode').targetProfile('/project'))
      .resolves.toEqual({
        model: 'claude-sonnet-4',
        modelProvider: 'anthropic',
        budgetCharacters: 288_000,
      })
  })

  it('refuses an in-flight OpenCode export before a transcript transform can replace it', async () => {
    mocks.exportOpencodeSession.mockResolvedValue({
      info: { id: 'ses_source' },
      messages: [{
        info: { id: 'msg_user', sessionID: 'ses_source', role: 'user', time: { created: 1 } },
        parts: [{ type: 'text', text: 'still running' }],
      }],
    })

    await expect(getHostTranscriptAdapter('opencode').read('/project', 'ses_source'))
      .rejects.toThrow('has an unfinished turn')
  })

  it('imports one projected OpenCode envelope instead of treating it as JSONL', async () => {
    mocks.importOpencodeSession.mockResolvedValue('ses_target')
    const value = { info: { id: 'ses_target' }, messages: [] }

    await expect(getHostTranscriptAdapter('opencode').write('/project', [value]))
      .resolves.toBe('opencode://session/ses_target')
    expect(mocks.importOpencodeSession).toHaveBeenCalledWith(
      { binary: '/tool', cwd: '/project' },
      value,
    )
  })

  it('uses the configured Codex model and its cached context metadata', async () => {
    mocks.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('config.toml')) {
        return 'model = "gpt-5.6-sol"\nmodel_provider = "openai"\n\n[projects."/tmp"]\ntrust_level = "trusted"\n'
      }
      if (path.endsWith('models_cache.json')) {
        return JSON.stringify({
          models: [{
            slug: 'gpt-5.6-sol',
            visibility: 'list',
            context_window: 272_000,
            effective_context_window_percent: 95,
          }],
        })
      }
      throw new Error(`Unexpected read: ${path}`)
    })

    await expect(getHostTranscriptAdapter('codex').targetProfile()).resolves.toEqual({
      model: 'gpt-5.6-sol',
      modelProvider: 'openai',
      budgetCharacters: 581_400,
    })
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

  it('rejects malformed middle JSONL instead of projecting the surrounding prefix', async () => {
    mocks.readFile.mockResolvedValue([
      jsonl({ type: 'session_meta', payload: { id: 'session' } }),
      '{"type":"response_item",broken}',
      jsonl({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'lost boundary' }] } }),
    ].join('\n'))

    await expect(getHostTranscriptAdapter('codex').read('/project', 'session'))
      .rejects.toThrow('contains malformed JSONL at physical line(s) 1')
    expect(mocks.readFile).toHaveBeenCalledTimes(1)
  })

  it('retries one partially appended tail and accepts it once complete', async () => {
    const complete = jsonl({
      type: 'user',
      sessionId: 'session',
      message: { role: 'user', content: 'complete prompt' },
    })
    mocks.readFile
      .mockResolvedValueOnce(`${complete}\n{"type":"assistant"`)
      .mockResolvedValueOnce(`${complete}\n`)

    await expect(getHostTranscriptAdapter('claude').read('/project', 'session'))
      .resolves.toMatchObject({ sourceProvider: 'claude', sourceSessionIds: ['session'] })
    expect(mocks.readFile).toHaveBeenCalledTimes(2)
  })

  it('rejects a partial tail that remains malformed after the bounded retry', async () => {
    mocks.readFile.mockResolvedValue([
      jsonl({ type: 'session_meta', payload: { id: 'session' } }),
      '{"type":"response_item"',
    ].join('\n'))

    await expect(getHostTranscriptAdapter('codex').read('/project', 'session'))
      .rejects.toThrow('contains malformed JSONL at physical line(s) 1')
    expect(mocks.readFile).toHaveBeenCalledTimes(2)
  })

  it('accepts a complete final JSON record without a newline', async () => {
    mocks.readFile.mockResolvedValue(jsonl({
      type: 'user',
      sessionId: 'session',
      message: { role: 'user', content: 'complete but unterminated' },
    }))

    await expect(getHostTranscriptAdapter('claude').read('/project', 'session'))
      .resolves.toMatchObject({ sourceProvider: 'claude', sourceSessionIds: ['session'] })
    expect(mocks.readFile).toHaveBeenCalledTimes(1)
  })
})

function jsonl(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}
