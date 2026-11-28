import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveCodexProxyDecision } from './codexProxyPolicy.js'
import { CodexSession } from './codexSession.js'

const harness = vi.hoisted(() => ({
  ptySpawns: [] as Array<{ binary: string; args: string[]; env: Record<string, string> }>,
  proxyCreateCalls: [] as Array<Record<string, unknown>>,
  proxyShouldThrow: false,
  proxyCreateHook: null as null | (() => Promise<void>),
}))

vi.mock('@main/storage/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/storage/paths.js')>()
  const { tmpdir: osTmpdir } = await import('node:os')
  const { join: pathJoin } = await import('node:path')
  return {
    ...actual,
    PROXY_EVENTS_DIR: pathJoin(osTmpdir(), 'agent-code-codex-proxy-test'),
    TLDR_HOOK_RUNTIME_DIR: pathJoin(osTmpdir(), 'agent-code-codex-tldr-test'),
  }
})

vi.mock('node-pty', () => ({
  spawn: (binary: string, args: string[], opts: { env: Record<string, string> }) => {
    harness.ptySpawns.push({ binary, args: [...args], env: { ...opts.env } })
    return {
      pid: 5150,
      process: binary,
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
      onData: () => ({ dispose: () => undefined }),
      onExit: () => ({ dispose: () => undefined }),
    }
  },
}))

vi.mock('codex-headless', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeCodexHeadless extends EventEmitter {
    semantic = new EventEmitter()
    async start() { return { sessionsDir: '/fake/codex/sessions' } }
    async stop() {}
    getScreen() { return '' }
    getSettledScreen() { return '' }
    getComposerState() { return 'empty' }
    getConditionSnapshot() { return { provider: 'codex', conditions: {}, ts: 0 } }
  }

  return {
    CodexHeadless: FakeCodexHeadless,
    CodexResponsesAdapter: class {
      attach() {}
      detach() {}
      diagnostics() { return { flows: 0, bufferedChars: 0 } }
    },
    ResponsesProxy: class {
      info = {
        proxyBaseUrl: 'http://127.0.0.1:19090/v1',
        upstreamBaseUrl: 'https://chatgpt.com/backend-api/codex',
        authMode: 'chatgpt' as const,
      }
      static async create(options: Record<string, unknown>) {
        harness.proxyCreateCalls.push(options)
        if (harness.proxyCreateHook) await harness.proxyCreateHook()
        if (harness.proxyShouldThrow) {
          throw new Error('EADDRINUSE: failed to bind local proxy')
        }
        return new this()
      }
      async stop() {}
    },
    ensureCodexProjectTrust: async () => 'already-trusted',
    prepareCodex01491PromptInputProfile: async () => ({ ok: false, reason: 'test-stub' }),
    prepareCodexResumeRollout: async () => ({ dispose: async () => {} }),
  }
})

describe('resolveCodexProxyDecision', () => {
  let codexHome: string

  beforeEach(async () => {
    codexHome = await mkdtemp(join(tmpdir(), 'codex-proxy-policy-'))
  })

  afterEach(async () => {
    await rm(codexHome, { recursive: true, force: true })
  })

  it('skips proxy when corporate proxy env var is set', async () => {
    await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }), 'utf8')
    const decision = await resolveCodexProxyDecision({
      CODEX_HOME: codexHome,
      HTTPS_PROXY: 'http://corp.proxy:8080',
    })
    expect(decision).toMatchObject({ useProxy: false, reason: 'corporate-proxy-env' })
  })

  it('skips proxy when config.toml sets a non-openai model_provider', async () => {
    await writeFile(join(codexHome, 'config.toml'), 'model_provider = "azure"\n', 'utf8')
    await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'apikey' }), 'utf8')
    const decision = await resolveCodexProxyDecision({ CODEX_HOME: codexHome })
    expect(decision).toMatchObject({ useProxy: false, reason: 'custom-model-provider' })
  })

  it('uses valid config.toml openai_base_url and ignores env.OPENAI_BASE_URL', async () => {
    await writeFile(
      join(codexHome, 'config.toml'),
      'model_provider = "openai"\nopenai_base_url = "https://gateway.example/v1"\n',
      'utf8',
    )
    expect(await resolveCodexProxyDecision({ CODEX_HOME: codexHome })).toEqual({
      useProxy: true,
      upstreamBaseUrl: 'https://gateway.example/v1',
    })

    // Codex CLI TUI does not read env.OPENAI_BASE_URL; with no auth.json,
    // env.OPENAI_BASE_URL alone must NOT enable the proxy.
    await writeFile(join(codexHome, 'config.toml'), '', 'utf8')
    expect(
      await resolveCodexProxyDecision({
        CODEX_HOME: codexHome,
        OPENAI_BASE_URL: 'https://env-gateway.example/v1',
      }),
    ).toMatchObject({
      useProxy: false,
      reason: 'indeterminate-auth-mode',
    })
  })

  it('skips proxy when config.toml sets invalid openai_base_url, profile, chatgpt_base_url, or keyring store', async () => {
    await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }), 'utf8')

    await writeFile(join(codexHome, 'config.toml'), 'openai_base_url = "not-a-url"\n', 'utf8')
    expect(await resolveCodexProxyDecision({ CODEX_HOME: codexHome })).toMatchObject({
      useProxy: false,
      reason: 'invalid-config',
    })

    await writeFile(join(codexHome, 'config.toml'), 'profile = "work"\n', 'utf8')
    expect(await resolveCodexProxyDecision({ CODEX_HOME: codexHome })).toMatchObject({
      useProxy: false,
      reason: 'custom-config-profile',
    })

    await writeFile(
      join(codexHome, 'config.toml'),
      'chatgpt_base_url = "https://enterprise.chatgpt.example"\n',
      'utf8',
    )
    expect(await resolveCodexProxyDecision({ CODEX_HOME: codexHome })).toMatchObject({
      useProxy: false,
      reason: 'custom-chatgpt-base-url',
    })

    await writeFile(
      join(codexHome, 'config.toml'),
      'cli_auth_credentials_store = "keyring"\n',
      'utf8',
    )
    expect(await resolveCodexProxyDecision({ CODEX_HOME: codexHome })).toMatchObject({
      useProxy: false,
      reason: 'keyring-credential-store',
    })
  })

  it.each(['chatgpt', 'chatgptAuthTokens', 'headers', 'agentIdentity', 'personalAccessToken'])(
    'detects chatgpt authMode for auth_mode=%s',
    async mode => {
      await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: mode }), 'utf8')
      expect(await resolveCodexProxyDecision({ CODEX_HOME: codexHome })).toEqual({
        useProxy: true,
        authMode: 'chatgpt',
      })
    },
  )

  it('detects chatgpt authMode when tokens exist without OPENAI_API_KEY', async () => {
    await writeFile(
      join(codexHome, 'auth.json'),
      JSON.stringify({ tokens: { access_token: 'jwt' } }),
      'utf8',
    )
    expect(await resolveCodexProxyDecision({ CODEX_HOME: codexHome })).toEqual({
      useProxy: true,
      authMode: 'chatgpt',
    })
  })

  it('detects apikey authMode from auth.json but does NOT infer apikey from env.OPENAI_API_KEY alone', async () => {
    await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'apikey' }), 'utf8')
    expect(await resolveCodexProxyDecision({ CODEX_HOME: codexHome })).toEqual({
      useProxy: true,
      authMode: 'apikey',
    })

    await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-test' }), 'utf8')
    expect(await resolveCodexProxyDecision({ CODEX_HOME: codexHome })).toEqual({
      useProxy: true,
      authMode: 'apikey',
    })

    // Developers with Keychain ChatGPT auth often export OPENAI_API_KEY for
    // other tools; absent auth.json must still skip rather than guess apikey.
    await rm(join(codexHome, 'auth.json'))
    expect(
      await resolveCodexProxyDecision({ CODEX_HOME: codexHome, OPENAI_API_KEY: 'sk-env' }),
    ).toMatchObject({
      useProxy: false,
      reason: 'indeterminate-auth-mode',
    })
  })

  it('skips proxy when auth.json is absent and OPENAI_API_KEY is unset (e.g. keyring store)', async () => {
    expect(await resolveCodexProxyDecision({ CODEX_HOME: codexHome })).toMatchObject({
      useProxy: false,
      reason: 'indeterminate-auth-mode',
    })
  })
})

describe('CodexSession proxy fail-open and NO_PROXY hygiene', () => {
  let codexHome: string

  beforeEach(async () => {
    codexHome = await mkdtemp(join(tmpdir(), 'codex-session-proxy-'))
    harness.ptySpawns = []
    harness.proxyCreateCalls = []
    harness.proxyShouldThrow = false
    harness.proxyCreateHook = null
  })

  afterEach(async () => {
    await rm(codexHome, { recursive: true, force: true })
  })

  it('merges NO_PROXY and passes detected authMode when ResponsesProxy starts', async () => {
    await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }), 'utf8')
    const session = new CodexSession({
      cwd: codexHome,
      useProxy: true,
      env: {
        CODEX_HOME: codexHome,
        NO_PROXY: 'internal.corp',
        HTTPS_PROXY: undefined,
        https_proxy: undefined,
        HTTP_PROXY: undefined,
        http_proxy: undefined,
        OPENAI_API_KEY: undefined,
        OPENAI_BASE_URL: undefined,
      },
    })

    await session.start()

    expect(harness.proxyCreateCalls).toHaveLength(1)
    expect(harness.proxyCreateCalls[0]).toMatchObject({ authMode: 'chatgpt' })
    expect(harness.ptySpawns).toHaveLength(1)
    expect(harness.ptySpawns[0].args).toContain('openai_base_url="http://127.0.0.1:19090/v1"')
    expect(harness.ptySpawns[0].env.NO_PROXY).toBe('internal.corp,localhost,127.0.0.1,::1')
    expect(harness.ptySpawns[0].env.no_proxy).toBe('internal.corp,localhost,127.0.0.1,::1')
  })

  it('falls back to direct spawn when ResponsesProxy.create throws', async () => {
    harness.proxyShouldThrow = true
    await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }), 'utf8')
    const session = new CodexSession({
      cwd: codexHome,
      useProxy: true,
      env: {
        CODEX_HOME: codexHome,
        HTTPS_PROXY: undefined,
        https_proxy: undefined,
        HTTP_PROXY: undefined,
        http_proxy: undefined,
        OPENAI_API_KEY: undefined,
        OPENAI_BASE_URL: undefined,
      },
    })
    const diagnostics: unknown[] = []
    const started: Array<{ projectDir: string; proxyUrl?: string }> = []
    session.on('transcript-diagnostic', d => diagnostics.push(d))
    session.on('started', s => started.push(s))

    await session.start()

    expect(harness.ptySpawns).toHaveLength(1)
    expect(harness.ptySpawns[0].args.join(' ')).not.toContain('openai_base_url')
    expect(started).toEqual([{ projectDir: '/fake/codex/sessions', proxyUrl: undefined }])
    expect(diagnostics.some(d => (d as { type?: string }).type === 'codex-proxy-fallback')).toBe(true)
  })

  it('skips proxy completely when auth mode is indeterminate', async () => {
    const session = new CodexSession({
      cwd: codexHome,
      useProxy: true,
      env: {
        CODEX_HOME: codexHome,
        HTTPS_PROXY: undefined,
        https_proxy: undefined,
        HTTP_PROXY: undefined,
        http_proxy: undefined,
        OPENAI_API_KEY: undefined,
        OPENAI_BASE_URL: undefined,
      },
    })

    await session.start()

    expect(harness.proxyCreateCalls).toHaveLength(0)
    expect(harness.ptySpawns).toHaveLength(1)
    expect(harness.ptySpawns[0].args.join(' ')).not.toContain('openai_base_url')
  })

  it('does not emit fallback or spawn PTY when a cancelled start attempt fails in ResponsesProxy.create', async () => {
    await writeFile(join(codexHome, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt' }), 'utf8')
    let releaseCreate!: () => void
    const createStarted = new Promise<void>(resolve => {
      harness.proxyCreateHook = async () => {
        resolve()
        await new Promise<void>(r => { releaseCreate = r })
      }
    })
    harness.proxyShouldThrow = true

    const session = new CodexSession({
      cwd: codexHome,
      useProxy: true,
      env: {
        CODEX_HOME: codexHome,
        HTTPS_PROXY: undefined,
        https_proxy: undefined,
        HTTP_PROXY: undefined,
        http_proxy: undefined,
      },
    })
    const diagnostics: unknown[] = []
    session.on('transcript-diagnostic', d => diagnostics.push(d))

    const startPromise = session.start()
    await createStarted
    const stopPromise = session.stop()
    releaseCreate()
    await Promise.all([startPromise, stopPromise])

    expect(harness.ptySpawns).toHaveLength(0)
    expect(diagnostics.some(d => (d as { type?: string }).type === 'codex-proxy-fallback')).toBe(false)
  })
})
