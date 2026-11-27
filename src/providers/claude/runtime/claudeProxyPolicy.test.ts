import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { hasCorporateProxyEnv, mergeNoProxy } from '@providers/shared/runtime/proxyEnv.js'
import {
  buildClaudeProxyEnv,
  evaluateClaudeProxyCompatibility,
} from './claudeProxyPolicy.js'
import { ClaudeSession } from './claudeSession.js'

const harness = vi.hoisted(() => ({
  ptySpawns: [] as Array<{ binary: string; args: string[]; env: Record<string, string> }>,
  headlessOptions: [] as Array<Record<string, unknown>>,
  proxyCreateCalls: 0,
  proxyCreateBehavior: 'ok' as 'ok' | 'throw-create' | 'throw-start',
  proxyStopped: 0,
  proxyWorkDir: '',
  proxyCaCertPath: '',
}))

vi.mock('node-pty', () => ({
  spawn: (binary: string, args: string[], opts: { env: Record<string, string> }) => {
    harness.ptySpawns.push({ binary, args, env: { ...opts.env } })
    return {
      pid: 4242,
      process: binary,
      write: () => undefined,
      resize: () => undefined,
      kill: () => undefined,
      onData: () => ({ dispose: () => undefined }),
      onExit: () => ({ dispose: () => undefined }),
    }
  },
}))

vi.mock('@main/setup/runtimeTools.js', () => ({
  resolveBundledTool: async () => '/fake/mitmdump',
}))

vi.mock('@main/setup/toolchain.js', () => ({
  getToolPath: () => null,
}))

vi.mock('@main/proxy/mitmproxyReaper.js', () => ({
  MITMPROXY_SHARED_CONF_DIR: '/fake/mitmproxy-conf',
  stopProxyServerWithDeadline: async (proxy: { stop: () => Promise<void> }) => {
    await proxy.stop()
    return { outcome: 'stopped', processes: [] }
  },
}))

vi.mock('claude-code-headless', async () => {
  const { EventEmitter } = await import('node:events')
  const { join: pathJoin } = await import('node:path')
  class FakeClaudeCodeHeadless extends EventEmitter {
    semantic = new EventEmitter()
    committed = new EventEmitter()

    constructor(options: Record<string, unknown>) {
      super()
      harness.headlessOptions.push(options)
    }

    async start() {
      return { projectDir: '/fake/project-dir' }
    }
    async stop() {}
    getSlashPickerState() { return { visible: false, items: [] } }
    getConditionSnapshot() { return { provider: 'claude', conditions: {}, ts: 0 } }
    getComposerState() { return { kind: 'empty' } }
    getScreen() { return '' }
    getScreenMarkdown() { return '' }
    getComposerAttributes() { return null }
    ingestProxyEvent() {}
    noteProxyTransportGap() {}
  }

  return {
    ClaudeCodeHeadless: FakeClaudeCodeHeadless,
    createProxyServer: async () => {
      harness.proxyCreateCalls += 1
      if (harness.proxyCreateBehavior === 'throw-create') {
        throw new Error('mitmdump binary missing')
      }
      const emitter = new EventEmitter()
      return Object.assign(emitter, {
        info: {
          workDir: harness.proxyWorkDir,
          confDir: '/fake/mitmproxy-conf',
          mitmDumpPath: '/fake/mitmdump',
          proxyPort: 18080,
          proxyUrl: 'http://127.0.0.1:18080',
          addonPath: '/fake/addon.py',
          eventsFile: pathJoin(harness.proxyWorkDir, 'proxy-events.jsonl'),
          caCertPath: harness.proxyCaCertPath,
        },
        start: async () => {
          if (harness.proxyCreateBehavior === 'throw-start') {
            throw new Error('mitmdump failed to bind port')
          }
        },
        stop: async () => {
          harness.proxyStopped += 1
        },
      })
    },
  }
})

describe('shared proxy env hygiene', () => {
  it('detects corporate proxy env vars across upper and lower case', () => {
    expect(hasCorporateProxyEnv({})).toBe(false)
    expect(hasCorporateProxyEnv({ HTTPS_PROXY: '   ' })).toBe(false)
    expect(hasCorporateProxyEnv({ HTTPS_PROXY: 'http://corp:8080' })).toBe(true)
    expect(hasCorporateProxyEnv({ https_proxy: 'http://corp:8080' })).toBe(true)
    expect(hasCorporateProxyEnv({ HTTP_PROXY: 'http://corp:8080' })).toBe(true)
    expect(hasCorporateProxyEnv({ http_proxy: 'http://corp:8080' })).toBe(true)
  })

  it('merges loopback hosts into existing NO_PROXY and no_proxy without clobbering or duplicating', () => {
    expect(mergeNoProxy({})).toBe('localhost,127.0.0.1,::1')
    expect(
      mergeNoProxy({
        NO_PROXY: 'internal.corp, 10.0.0.0/8, LOCALHOST',
        no_proxy: 'internal.corp, .svc.local',
      }),
    ).toBe('internal.corp,10.0.0.0/8,LOCALHOST,.svc.local,127.0.0.1,::1')
  })
})

describe('evaluateClaudeProxyCompatibility', () => {
  it('allows default clean environments', () => {
    expect(evaluateClaudeProxyCompatibility({ PATH: '/usr/bin' })).toEqual({ allow: true })
  })

  it.each(['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'])(
    'skips proxy when %s is set',
    key => {
      const decision = evaluateClaudeProxyCompatibility({ [key]: 'http://proxy.corp:8080' })
      expect(decision.allow).toBe(false)
      if (!decision.allow) expect(decision.reason).toBe('corporate-proxy-env')
    },
  )

  it.each(['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY'])(
    'skips proxy when %s is truthy and allows when explicitly falsy',
    key => {
      const truthy = evaluateClaudeProxyCompatibility({ [key]: '1' })
      expect(truthy.allow).toBe(false)
      if (!truthy.allow) expect(truthy.reason).toBe('non-anthropic-backend')

      expect(evaluateClaudeProxyCompatibility({ [key]: '0' })).toEqual({ allow: true })
      expect(evaluateClaudeProxyCompatibility({ [key]: 'false' })).toEqual({ allow: true })
    },
  )

  it('skips proxy for plain-HTTP or loopback ANTHROPIC_BASE_URL', () => {
    for (const url of [
      'http://litellm.internal:4000',
      'https://localhost:8443/v1',
      'https://127.0.0.1:8443',
      'https://[::1]:8443',
    ]) {
      const decision = evaluateClaudeProxyCompatibility({ ANTHROPIC_BASE_URL: url })
      expect(decision.allow).toBe(false)
      if (!decision.allow) expect(decision.reason).toBe('local-or-http-base-url')
    }
    expect(
      evaluateClaudeProxyCompatibility({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com' }),
    ).toEqual({ allow: true })
  })
})

describe('buildClaudeProxyEnv', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'claude-proxy-env-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('merges user NODE_EXTRA_CA_CERTS with mitmproxy CA into workDir and preserves NO_PROXY', async () => {
    const userCa = join(tempDir, 'corp-ca.pem')
    const mitmCa = join(tempDir, 'mitm-ca.pem')
    await writeFile(userCa, '-----BEGIN CERTIFICATE-----\nCORP\n-----END CERTIFICATE-----', 'utf8')
    await writeFile(mitmCa, '-----BEGIN CERTIFICATE-----\nMITM\n-----END CERTIFICATE-----\n', 'utf8')

    const env = await buildClaudeProxyEnv(
      {
        NO_PROXY: 'corp.local',
        NODE_EXTRA_CA_CERTS: userCa,
      },
      {
        proxyUrl: 'http://127.0.0.1:18080',
        caCertPath: mitmCa,
        workDir: tempDir,
      },
    )

    expect(env.NO_PROXY).toBe('corp.local,localhost,127.0.0.1,::1')
    expect(env.no_proxy).toBe('corp.local,localhost,127.0.0.1,::1')
    expect(env.NODE_EXTRA_CA_CERTS).toBe(join(tempDir, 'combined-extra-ca-certs.pem'))
    const merged = await readFile(env.NODE_EXTRA_CA_CERTS, 'utf8')
    expect(merged).toContain('CORP')
    expect(merged).toContain('MITM')
  })

  it('throws when user NODE_EXTRA_CA_CERTS is unreadable so caller can fail open', async () => {
    const mitmCa = join(tempDir, 'mitm-ca.pem')
    await writeFile(mitmCa, '-----BEGIN CERTIFICATE-----\nMITM\n-----END CERTIFICATE-----\n', 'utf8')

    await expect(
      buildClaudeProxyEnv(
        { NODE_EXTRA_CA_CERTS: join(tempDir, 'does-not-exist.pem') },
        { proxyUrl: 'http://127.0.0.1:18080', caCertPath: mitmCa, workDir: tempDir },
      ),
    ).rejects.toThrow()
  })
})

describe('ClaudeSession proxy fail-open', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'claude-session-proxy-'))
    harness.ptySpawns = []
    harness.headlessOptions = []
    harness.proxyCreateCalls = 0
    harness.proxyCreateBehavior = 'ok'
    harness.proxyStopped = 0
    harness.proxyWorkDir = tempDir
    harness.proxyCaCertPath = join(tempDir, 'mitm-ca.pem')
    await writeFile(harness.proxyCaCertPath, '-----BEGIN CERTIFICATE-----\nMITM\n-----END CERTIFICATE-----\n', 'utf8')
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('falls back to direct spawn without aborting when proxy.start() throws', async () => {
    harness.proxyCreateBehavior = 'throw-start'
    const session = new ClaudeSession({
      cwd: tempDir,
      useProxy: true,
      env: { HTTPS_PROXY: undefined, https_proxy: undefined, HTTP_PROXY: undefined, http_proxy: undefined },
    })
    const diagnostics: unknown[] = []
    const started: Array<{ projectDir: string; proxyUrl?: string }> = []
    session.on('transcript-diagnostic', d => diagnostics.push(d))
    session.on('started', s => started.push(s))

    await session.start()

    expect(harness.proxyCreateCalls).toBe(1)
    expect(harness.proxyStopped).toBe(1)
    expect(harness.ptySpawns).toHaveLength(1)
    expect(harness.ptySpawns[0].env.HTTPS_PROXY).toBeUndefined()
    expect(harness.headlessOptions[0].proxy).toBeUndefined()
    expect(started).toEqual([{ projectDir: '/fake/project-dir', proxyUrl: undefined }])
    expect(diagnostics.length).toBeGreaterThan(0)
  })

  it('tears down proxy and falls back to direct spawn when user NODE_EXTRA_CA_CERTS is unreadable', async () => {
    const session = new ClaudeSession({
      cwd: tempDir,
      useProxy: true,
      env: {
        HTTPS_PROXY: undefined,
        https_proxy: undefined,
        HTTP_PROXY: undefined,
        http_proxy: undefined,
        NODE_EXTRA_CA_CERTS: join(tempDir, 'missing.pem'),
      },
    })

    await session.start()

    expect(harness.proxyCreateCalls).toBe(1)
    expect(harness.proxyStopped).toBe(1)
    expect(harness.ptySpawns).toHaveLength(1)
    expect(harness.ptySpawns[0].env.HTTPS_PROXY).toBeUndefined()
    expect(harness.ptySpawns[0].env.NODE_EXTRA_CA_CERTS).toBe(join(tempDir, 'missing.pem'))
    expect(harness.headlessOptions[0].proxy).toBeUndefined()
  })

  it('skips creating mitmproxy altogether when corporate HTTPS_PROXY is already set', async () => {
    const session = new ClaudeSession({
      cwd: tempDir,
      useProxy: true,
      env: { HTTPS_PROXY: 'http://corp-proxy:8080' },
    })

    await session.start()

    expect(harness.proxyCreateCalls).toBe(0)
    expect(harness.ptySpawns).toHaveLength(1)
    expect(harness.ptySpawns[0].env.HTTPS_PROXY).toBe('http://corp-proxy:8080')
    expect(harness.headlessOptions[0].proxy).toBeUndefined()
  })
})
