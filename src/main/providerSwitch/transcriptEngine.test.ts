import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  exportOpencodeSession: vi.fn(),
  importOpencodeSession: vi.fn(),
  listOpencodeModels: vi.fn(),
  readResolvedOpencodeConfig: vi.fn(),
  readOpencodeModelState: vi.fn(async () => ({ recent: [] as string[], variants: {} as Record<string, string> })),
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
vi.mock('@providers/opencode/runtime/opencodeCliSessions.js', async () => ({
  // The pure selection rule is the code under test; only I/O is stubbed.
  selectOpencodeTargetModel: (await vi.importActual<typeof import('@providers/opencode/runtime/opencodeCliSessions.js')>('@providers/opencode/runtime/opencodeCliSessions.js')).selectOpencodeTargetModel,
  exportOpencodeSession: mocks.exportOpencodeSession,
  importOpencodeSession: mocks.importOpencodeSession,
  listOpencodeModels: mocks.listOpencodeModels,
  readResolvedOpencodeConfig: mocks.readResolvedOpencodeConfig,
  readOpencodeModelState: mocks.readOpencodeModelState,
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
    // Transform exports are the large ones #845 fixed; the startup 30 s bound
    // must not apply to them.
    expect(mocks.exportOpencodeSession).toHaveBeenCalledWith(
      { binary: '/tool', cwd: '/project', timeoutMs: 300_000 },
      'ses_source',
    )
  })

  it('imports one projected OpenCode envelope instead of treating it as JSONL', async () => {
    mocks.importOpencodeSession.mockResolvedValue('ses_target')
    const value = { info: { id: 'ses_target' }, messages: [] }

    await expect(getHostTranscriptAdapter('opencode').write('/project', { values: [value] }))
      .resolves.toBe('opencode://session/ses_target')
    // A projected import carries a whole conversation, so it must not inherit
    // the 30 s bound meant for the terminal's empty-session startup import.
    expect(mocks.importOpencodeSession).toHaveBeenCalledWith(
      { binary: '/tool', cwd: '/project', timeoutMs: 300_000 },
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

// B18: switching to OpenCode pinned `opencode/big-pickle`, the first row of
// `opencode models`, onto every imported message. The inputs below are the
// owner's REAL OpenCode state (testing/fixtures/opencode-model-selection:
// model.json and the `opencode models` output, recorded together). The state
// is parsed by the real parser and the selection is the real rule; only the
// file and CLI I/O are stubbed. The order under test is OpenCode's own,
// verified in the 1.18.31 binary by the #1034 review: agent model, config
// model, first recent, catalog default, each checked against the catalog.
describe('OpenCode switch target model (B18)', () => {
  const fixtures = new URL('../../../testing/fixtures/opencode-model-selection/', import.meta.url)
  const actualFs = () => vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const recordedModels = async () => (await actualFs())
    .readFile(new URL('opencode-models.txt', fixtures), 'utf8')
    .then(text => text.split(/\r?\n/u).map(line => line.trim()).filter(line => /^[^/\s]+\/.+/u.test(line)))
  const recordedState = async () => {
    const { opencodeModelStateFrom } = await vi.importActual<typeof import('@providers/opencode/runtime/opencodeCliSessions.js')>('@providers/opencode/runtime/opencodeCliSessions.js')
    return opencodeModelStateFrom(JSON.parse(await (await actualFs()).readFile(new URL('model.json', fixtures), 'utf8')) as unknown)
  }
  const target = async () => {
    const profile = await getHostTranscriptAdapter('opencode').targetProfile('/project')
    return `${profile.modelProvider}/${profile.model}`
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    // The owner's resolved config sets no model: the case that fell through
    // to the catalog's first row.
    mocks.readResolvedOpencodeConfig.mockResolvedValue({})
    mocks.listOpencodeModels.mockResolvedValue(await recordedModels())
    mocks.readOpencodeModelState.mockResolvedValue(await recordedState())
  })

  it('uses the model the user last picked, with its saved reasoning variant', async () => {
    const profile = await getHostTranscriptAdapter('opencode').targetProfile('/project')
    expect(profile).toMatchObject({ modelProvider: 'zai-coding-plan', model: 'glm-5.3', modelVariant: 'max' })
  })

  it('stamps that variant on the projected session, so opening it does not reset the user\'s effort', async () => {
    const conversation = {
      schemaVersion: 1 as const, sourceProvider: 'claude' as const, sourceSessionIds: ['source'],
      entries: [{ kind: 'message' as const, role: 'user' as const, content: [{ kind: 'text' as const, text: 'hello' }], timestamp: '2026-09-19T00:00:00.000Z', source: { provider: 'claude', line: 1, raw: {}, evidence: [] } }],
    }
    const projection = await getHostTranscriptAdapter('opencode').projectNativeResume(conversation as never, {
      cwd: '/project', targetSessionId: 'target', now: '2026-09-19T00:00:00.000Z',
    })
    const exported = projection.values[0] as { messages: Array<{ info: { role: string; model?: unknown } }> }
    expect(exported.messages.filter(message => message.info.role === 'user').map(message => message.info.model))
      .toEqual([{ providerID: 'zai-coding-plan', modelID: 'glm-5.3', variant: 'max' }])
  })

  it('skips a recent model this install no longer offers', async () => {
    const { recent: [newest, ...older] } = await recordedState()
    const offered = (await recordedModels()).filter(model => model !== newest)
    mocks.listOpencodeModels.mockResolvedValue(offered)
    expect(await target()).toBe(older.find(model => offered.includes(model)))
  })

  it('a user who never picked a model still gets a target, so Duplicate and Rewind keep working', async () => {
    // OpenCode itself falls back to its provider default here; the catalog's
    // first row is the closest this can name (#1034 review).
    mocks.readOpencodeModelState.mockResolvedValue({ recent: [], variants: {} })
    expect(await target()).toBe((await recordedModels())[0])
  })

  it('skips a configured model the catalog does not offer, as the TUI does', async () => {
    mocks.readResolvedOpencodeConfig.mockResolvedValue({ model: 'anthropic/claude-opus-4-6' })
    expect(await target()).toBe('zai-coding-plan/glm-5.3')
  })

  it('uses an offered configured model over every recent', async () => {
    mocks.readResolvedOpencodeConfig.mockResolvedValue({ model: 'openai/gpt-5.4' })
    expect(await target()).toBe('openai/gpt-5.4')
  })

  it('ranks the default agent\'s own model above the configured model', async () => {
    mocks.readResolvedOpencodeConfig.mockResolvedValue({ model: 'openai/gpt-5.4', agent: { build: { model: 'openai/gpt-5.6-sol' } } })
    expect(await target()).toBe('openai/gpt-5.6-sol')
  })

  it('with the catalog unreadable, uses only an explicit choice, and otherwise asks', async () => {
    mocks.listOpencodeModels.mockRejectedValue(new Error('opencode models failed'))
    mocks.readResolvedOpencodeConfig.mockResolvedValue({ model: 'openai/gpt-5.4' })
    expect(await target()).toBe('openai/gpt-5.4')
    mocks.readResolvedOpencodeConfig.mockResolvedValue({})
    await expect(target()).rejects.toThrow(/select a model in OpenCode/)
  })
})
