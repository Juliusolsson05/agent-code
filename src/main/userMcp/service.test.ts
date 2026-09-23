import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SecretCodec } from '@main/keyVault/vaultStore.js'
import type { NativeMcpServer, UserMcpSaveInput } from '@shared/userMcp/types.js'

import { readNativeMcpServers, codexNativeServerNames } from './nativeServers.js'
import { UserMcpService } from './service.js'

// Reversible stand-in for safeStorage: the tests are about WHERE values go,
// not about the OS cipher. The prefix makes an accidental plaintext write
// (a value that skipped encrypt) visible as a mismatch.
const codec: SecretCodec = {
  isEncryptionAvailable: () => true,
  encrypt: plain => Buffer.from(`enc:${plain}`, 'utf8'),
  decrypt: cipher => {
    const text = cipher.toString('utf8')
    if (!text.startsWith('enc:')) throw new Error('not ours')
    return text.slice(4)
  },
}

const TOKEN = 'bpr_live_9f3a1c7d'

let dir: string
let native: NativeMcpServer[]
let codexNames: Set<string>
let managed: boolean

function service(): UserMcpService {
  return new UserMcpService({
    stateDir: dir,
    codec,
    native: {
      list: async () => native,
      codexNames: async () => codexNames,
      claudeManagedPolicy: async () => managed,
    },
  })
}

const beeper = (overrides: Partial<UserMcpSaveInput> = {}): UserMcpSaveInput => ({
  name: 'beeper',
  enabled: true,
  providers: { claude: true, codex: true },
  entry: { type: 'http', url: 'http://localhost:23373/v0/mcp', headers: { Authorization: 'Bearer ${input:beeper-authorization}' } },
  inputs: [{ id: 'beeper-authorization', description: 'Header Authorization' }],
  secrets: { 'beeper-authorization': TOKEN },
  ...overrides,
})

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'user-mcp-'))
  native = []
  codexNames = new Set()
  managed = false
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('UserMcpService storage', () => {
  it('persists the server without its secret, and the snapshot shows only a hint', async () => {
    const result = await service().save(beeper())
    expect(result.ok).toBe(true)
    const onDisk = await readFile(join(dir, 'mcp-servers.json'), 'utf8')
    expect(onDisk).toContain('beeper')
    expect(onDisk).not.toContain(TOKEN)
    expect((await stat(join(dir, 'mcp-servers.json'))).mode & 0o777).toBe(0o600)
    if (!result.ok) return
    expect(JSON.stringify(result.snapshot)).not.toContain(TOKEN)
    expect(result.snapshot.servers[0]!.secrets['beeper-authorization']).toEqual({ set: true, hint: '1c7d' })
  })

  it('refuses structurally invalid servers but accepts a server whose secret is not set yet', async () => {
    const svc = service()
    expect(await svc.save(beeper({ name: 'agent_code' }))).toMatchObject({ ok: false })
    const pending = await svc.save(beeper({ secrets: {} }))
    expect(pending.ok).toBe(true)
    if (!pending.ok) return
    expect(pending.snapshot.servers[0]!.problems.map(problem => problem.kind)).toEqual(['secret-missing'])
  })

  it('moves an unreadable document aside instead of erasing it', async () => {
    await writeFile(join(dir, 'mcp-servers.json'), '{ not json')
    const snapshot = await service().snapshot()
    expect(snapshot.servers).toEqual([])
    expect(snapshot.storeProblem).toMatch(/moved to/)
    expect((await readdir(dir)).some(file => file.startsWith('mcp-servers.json.corrupt-'))).toBe(true)
  })

  it('deletes a server together with its secrets', async () => {
    const svc = service()
    const saved = await svc.save(beeper())
    if (!saved.ok) throw new Error(saved.error)
    await svc.delete(saved.id!)
    expect(await readdir(join(dir, 'mcp-secrets'))).toEqual([])
  })

  it('copies a CLI-native server in, attached only to the other provider, with secrets unset', async () => {
    native = [{
      provider: 'codex', name: 'sentry', source: '~/.codex/config.toml', transport: 'http', summary: 'mcp.sentry.dev/mcp',
      entry: { type: 'http', url: 'https://mcp.sentry.dev/mcp', headers: { Authorization: 'Bearer ${input:sentry-authorization}' } },
      inputs: [{ id: 'sentry-authorization', description: 'Header Authorization' }],
    }]
    const result = await service().copyNative('codex', 'sentry')
    if (!result.ok) throw new Error(result.error)
    const copy = result.snapshot.servers[0]!
    expect(copy.providers).toEqual({ claude: true, codex: false })
    expect(copy.secrets['sentry-authorization']).toEqual({ set: false })
  })
})

describe('UserMcpService.resolveForLaunch', () => {
  async function saved(input: UserMcpSaveInput = beeper()) {
    const svc = service()
    const result = await svc.save(input)
    if (!result.ok) throw new Error(result.error)
    return { svc, id: result.id! }
  }

  it('attaches a default-on server with its secret resolved', async () => {
    const { svc, id } = await saved()
    const resolution = await svc.resolveForLaunch({ provider: 'codex', overrides: {}, cwd: dir })
    expect(resolution.attachedIds).toEqual([id])
    expect(resolution.servers[0]!.secrets).toEqual({ 'beeper-authorization': TOKEN })
    expect(resolution.dropped).toEqual([])
  })

  it('lets a per-agent override add or remove a server', async () => {
    const { svc, id } = await saved(beeper({ providers: { claude: false, codex: false } }))
    expect((await svc.resolveForLaunch({ provider: 'claude', overrides: {}, cwd: dir })).attachedIds).toEqual([])
    expect((await svc.resolveForLaunch({ provider: 'claude', overrides: { [id]: true }, cwd: dir })).attachedIds).toEqual([id])
    const { svc: svc2, id: id2 } = await saved(beeper({ name: 'beeper2' }))
    expect((await svc2.resolveForLaunch({ provider: 'claude', overrides: { [id2]: false }, cwd: dir })).attachedIds)
      .not.toContain(id2)
  })

  it('never attaches a server whose master switch is off, even with a per-agent on', async () => {
    const { svc, id } = await saved(beeper({ enabled: false }))
    const resolution = await svc.resolveForLaunch({ provider: 'claude', overrides: { [id]: true }, cwd: dir })
    expect(resolution.attachedIds).toEqual([])
    // Silent: the user turned it off everywhere, so there is nothing to warn about.
    expect(resolution.dropped).toEqual([])
  })

  it('drops a requested server with a reason when its secret is missing', async () => {
    const { svc } = await saved(beeper({ secrets: {} }))
    const resolution = await svc.resolveForLaunch({ provider: 'claude', overrides: {}, cwd: dir })
    expect(resolution.attachedIds).toEqual([])
    expect(resolution.dropped).toEqual([{ name: 'beeper', reason: 'Secret "beeper-authorization" is not set' }])
  })

  it('refuses a Codex name that is already in the user\'s Codex config, but not for Claude', async () => {
    const { svc, id } = await saved()
    codexNames = new Set(['beeper'])
    expect((await svc.resolveForLaunch({ provider: 'codex', overrides: {}, cwd: dir })).dropped[0]?.reason)
      .toMatch(/already in your Codex config/)
    expect((await svc.resolveForLaunch({ provider: 'claude', overrides: {}, cwd: dir })).attachedIds).toEqual([id])
  })

  it('holds user servers back for Claude under an enterprise MCP policy', async () => {
    const { svc } = await saved()
    managed = true
    const resolution = await svc.resolveForLaunch({ provider: 'claude', overrides: {}, cwd: dir })
    expect(resolution.attachedIds).toEqual([])
    expect(resolution.dropped[0]?.reason).toMatch(/policy/)
  })

  it('keeps SSE servers off Codex with a reason', async () => {
    const { svc } = await saved(beeper({
      name: 'linear', entry: { type: 'sse', url: 'https://mcp.linear.app/sse' }, inputs: [], secrets: {},
    }))
    const resolution = await svc.resolveForLaunch({ provider: 'codex', overrides: {}, cwd: dir })
    expect(resolution.dropped).toEqual([{ name: 'linear', reason: 'Codex does not support SSE servers' }])
  })

  it('gives providers without user MCP support nothing', async () => {
    const { svc } = await saved()
    expect(await svc.resolveForLaunch({ provider: 'opencode', overrides: {}, cwd: dir }))
      .toEqual({ servers: [], attachedIds: [], dropped: [] })
  })
})

describe('native server discovery', () => {
  it('reads user-scope servers from both CLIs and never forwards their values', async () => {
    await writeFile(join(dir, '.claude.json'), JSON.stringify({
      mcpServers: { context7: { type: 'http', url: 'https://mcp.context7.com/mcp', headers: { CONTEXT7_API_KEY: 'ctx7_secret' } } },
    }))
    const codexHome = join(dir, 'codex')
    await import('node:fs/promises').then(fs => fs.mkdir(codexHome))
    await writeFile(join(codexHome, 'config.toml'), [
      '[mcp_servers.sentry]',
      'url = "https://mcp.sentry.dev/mcp"',
      'bearer_token_env_var = "SENTRY_TOKEN"',
      '',
      '[mcp_servers.fs]',
      'command = "npx"',
      'args = ["-y", "@modelcontextprotocol/server-filesystem"]',
      'env = { ROOT_TOKEN = "fs_secret" }',
    ].join('\n'))
    const servers = await readNativeMcpServers({ home: dir, codexHome, platform: 'darwin' })
    expect(servers.map(server => `${server.provider}:${server.name}`)).toEqual(['claude:context7', 'codex:sentry', 'codex:fs'])
    expect(JSON.stringify(servers)).not.toMatch(/ctx7_secret|fs_secret/)
    expect(servers.find(server => server.name === 'sentry')!.entry).toEqual({
      type: 'http', url: 'https://mcp.sentry.dev/mcp', headers: { Authorization: 'Bearer ${input:sentry-authorization}' },
    })
    expect(await codexNativeServerNames(join(dir, 'project'), { home: dir, codexHome, platform: 'darwin' }))
      .toEqual(new Set(['sentry', 'fs']))
  })
})
