import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { SecretCodec } from '@main/keyVault/vaultStore.js'
import type { NativeMcpServerSource, UserMcpSaveInput } from '@shared/userMcp/types.js'

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
let native: NativeMcpServerSource[]
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

// The token a LAUNCH would hand this server (q113: secrets are read bound to
// the server's current destination, so this is the observable pairing).
async function launchedToken(svc: UserMcpService, id: string): Promise<string | null> {
  const resolution = await svc.resolveForLaunch({ provider: 'claude', overrides: {}, cwd: dir })
  return resolution.servers.find(server => server.id === id)?.secrets['beeper-authorization'] ?? null
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
      provider: 'codex', name: 'sentry', source: '~/.codex/config.toml', transport: 'http', summary: 'mcp.sentry.dev/mcp', copyable: true,
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

describe('UserMcpService unreadable document (review round 1)', () => {
  it('refuses writes while the document cannot be read, instead of replacing it with an empty list', async () => {
    const file = join(dir, 'mcp-servers.json')
    await writeFile(file, JSON.stringify({ version: 1, servers: [{ id: 'keep-me', name: 'kept', enabled: true, providers: { claude: true, codex: true }, entry: { command: 'x' }, inputs: [] }] }))
    const { chmod } = await import('node:fs/promises')
    await chmod(file, 0o000)
    try {
      const svc = service()
      const result = await svc.save(beeper())
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toMatch(/Nothing was changed/)
    } finally {
      await chmod(file, 0o600)
    }
    expect(await readFile(file, 'utf8')).toContain('keep-me')
  })

  it('recovers once the document becomes readable again', async () => {
    const file = join(dir, 'mcp-servers.json')
    await writeFile(file, JSON.stringify({ version: 1, servers: [{ id: 'keep-me', name: 'kept', enabled: true, providers: { claude: true, codex: true }, entry: { command: 'x' }, inputs: [] }] }))
    const { chmod } = await import('node:fs/promises')
    await chmod(file, 0o000)
    const svc = service()
    await svc.initialize()
    await chmod(file, 0o600)
    const result = await svc.save(beeper())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.snapshot.servers.map(server => server.name).sort()).toEqual(['beeper', 'kept'])
  })
})

describe('UserMcpService secret redirection (review round 1)', () => {
  it('forgets stored secrets when a server is pointed somewhere else', async () => {
    const svc = service()
    const saved = await svc.save(beeper())
    if (!saved.ok) throw new Error(saved.error)
    const moved = await svc.save({ ...beeper(), id: saved.id, secrets: undefined, entry: { type: 'http', url: 'https://evil.example/mcp', headers: { Authorization: 'Bearer ${input:beeper-authorization}' } } })
    expect(moved).toMatchObject({ ok: true, secretsCleared: true })
    const launch = await svc.resolveForLaunch({ provider: 'claude', overrides: {}, cwd: dir })
    // The token never reaches the new host: the server is dropped instead.
    expect(launch.servers).toEqual([])
    expect(launch.dropped[0]?.reason).toMatch(/not set/)
  })

  it('keeps secrets when only the name or the providers change', async () => {
    const svc = service()
    const saved = await svc.save(beeper())
    if (!saved.ok) throw new Error(saved.error)
    const edited = await svc.save({ ...beeper(), id: saved.id, name: 'beeper-desktop', secrets: undefined, providers: { claude: true, codex: false } })
    expect(edited).toMatchObject({ ok: true })
    expect(edited).not.toHaveProperty('secretsCleared')
    expect((await svc.resolveForLaunch({ provider: 'claude', overrides: {}, cwd: dir })).servers[0]?.secrets)
      .toEqual({ 'beeper-authorization': TOKEN })
  })
})


describe('UserMcpService review round 2', () => {
  const stdio = (env: Record<string, string>): UserMcpSaveInput => ({
    name: 'gh', enabled: true, providers: { claude: true, codex: true },
    entry: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env },
    inputs: [{ id: 'pat', description: '' }], secrets: { pat: TOKEN },
  })

  it('forgets secrets when a literal env value is added, not only when the command moves', async () => {
    // NODE_OPTIONS=--require ./evil.js runs attacker code with the token in
    // its env even though command/args/url are unchanged.
    const svc = service()
    const saved = await svc.save(stdio({ GITHUB_PERSONAL_ACCESS_TOKEN: '${input:pat}' }))
    if (!saved.ok) throw new Error(saved.error)
    const edited = await svc.save({ ...stdio({ GITHUB_PERSONAL_ACCESS_TOKEN: '${input:pat}', NODE_OPTIONS: '--require /tmp/evil.js' }), id: saved.id, secrets: undefined })
    expect(edited).toMatchObject({ ok: true, secretsCleared: true })
  })

  it('stores a server an agent adds switched off and flagged for review', async () => {
    const svc = service()
    const added = await svc.save(beeper(), 'agent')
    if (!added.ok) throw new Error(added.error)
    const view = added.snapshot.servers[0]!
    expect(view.enabled).toBe(false)
    expect(view.pendingReview).toBe(true)
    expect(view.problems[0]?.kind).toBe('pending-review')
    expect((await svc.resolveForLaunch({ provider: 'claude', overrides: { [view.id]: true }, cwd: dir })).servers).toEqual([])
  })

  it('never lets an agent turn a server on, and lets the user approve it', async () => {
    const svc = service()
    const added = await svc.save(beeper(), 'agent')
    if (!added.ok) throw new Error(added.error)
    const id = added.id!
    expect(await svc.setEnabled(id, true, 'agent')).toMatchObject({ ok: false })
    expect(await svc.save({ ...beeper(), id, enabled: true }, 'agent')).toMatchObject({ ok: true })
    expect((await svc.snapshot()).servers[0]!.enabled).toBe(false)
    const approved = await svc.setEnabled(id, true)
    if (!approved.ok) throw new Error(approved.error)
    expect(approved.snapshot.servers[0]!.pendingReview).toBeUndefined()
    expect((await svc.resolveForLaunch({ provider: 'claude', overrides: {}, cwd: dir })).attachedIds).toEqual([id])
  })

  it('switches an approved server back off when an agent points it somewhere new', async () => {
    const svc = service()
    const saved = await svc.save(beeper())
    if (!saved.ok) throw new Error(saved.error)
    const moved = await svc.save({ ...beeper(), id: saved.id, secrets: undefined, entry: { type: 'http', url: 'https://evil.example/mcp' }, inputs: [] }, 'agent')
    expect(moved).toMatchObject({ ok: true, pendingReview: true })
    expect((await svc.snapshot()).servers[0]!.enabled).toBe(false)
  })

  it('refuses a secret value that Claude would expand from its own environment', async () => {
    const svc = service()
    expect(await svc.save(beeper({ secrets: { 'beeper-authorization': '${GITHUB_TOKEN}' } }))).toMatchObject({ ok: false })
  })
})

// #1304: mutate() rolled MEMORY back on a failure, but persist() had already
// written the new document. A failed secret write after a save, or a failed
// clear after a delete, left disk and memory disagreeing: the server came back
// after a restart (without its secret), or the next mutation wrote a deleted
// server back.
describe('a secret step that fails after the document was written (#1304)', () => {
  type Internals = { secrets: { set: (...args: unknown[]) => Promise<void>; clearServer: (...args: unknown[]) => Promise<void> } }

  it('a failed secret write on save leaves the server on neither disk nor memory', async () => {
    const live = service()
    ;(live as unknown as Internals).secrets.set = async () => { throw new Error('secure storage unavailable') }
    const result = await live.save(beeper())
    expect(result.ok).toBe(false)
    expect((await live.snapshot()).servers).toHaveLength(0)
    expect((await service().snapshot()).servers).toHaveLength(0)
  })

  it('a failed secret clear on delete keeps the server on both disk and memory', async () => {
    const live = service()
    expect((await live.save(beeper())).ok).toBe(true)
    const id = (await live.snapshot()).servers[0]!.id
    ;(live as unknown as Internals).secrets.clearServer = async () => { throw new Error('EACCES') }
    expect((await live.delete(id)).ok).toBe(false)
    expect((await live.snapshot()).servers.map(server => server.id)).toEqual([id])
    expect((await service().snapshot()).servers.map(server => server.id)).toEqual([id])
  })
})

// q108: rolling the document back is not enough if the secret step already
// erased the old secret. A destination change clears the server's blobs, then
// sets the new ones; if a set fails after the clear, the old server came back
// (document rolled back) WITHOUT its token.
describe('a secret step that fails midway keeps the previous secret (#1304, q108)', () => {
  type Store = {
    get: (serverId: string, inputId: string) => Promise<string | null>
    set: (serverId: string, inputId: string, value: string) => Promise<void>
    clearServer: (serverId: string) => Promise<void>
  }
  const storeOf = (svc: UserMcpService) => (svc as unknown as { secrets: Store }).secrets

  it('a destination change whose new secret fails to write keeps the old destination AND its token', async () => {
    const live = service()
    expect((await live.save(beeper())).ok).toBe(true)
    const id = (await live.snapshot()).servers[0]!.id
    const store = storeOf(live)
    store.set = async () => { throw new Error('secure storage unavailable') }
    const moved = await live.save(beeper({
      id,
      entry: { type: 'http', url: 'http://localhost:9999/v0/mcp', headers: { Authorization: 'Bearer ${input:beeper-authorization}' } },
      secrets: { 'beeper-authorization': 'bpr_live_new_token_0000' },
    } as Partial<UserMcpSaveInput>))
    expect(moved.ok).toBe(false)
    const restarted = service()
    const [server] = (await restarted.snapshot()).servers
    expect(server?.id).toBe(id)
    expect(JSON.stringify(server)).toContain('localhost:23373')
    expect(await launchedToken(restarted, id)).toBe(TOKEN)
  })

  it('a delete whose clear fails after removing some blobs keeps the server AND its token', async () => {
    const live = service()
    expect((await live.save(beeper())).ok).toBe(true)
    const id = (await live.snapshot()).servers[0]!.id
    const store = storeOf(live)
    const realClear = store.clearServer.bind(store)
    store.clearServer = async serverId => { await realClear(serverId); throw new Error('EACCES') }
    expect((await live.delete(id)).ok).toBe(false)
    const restarted = service()
    expect((await restarted.snapshot()).servers.map(server => server.id)).toEqual([id])
    expect(await launchedToken(restarted, id)).toBe(TOKEN)
  })
})

// q110 (SECURITY, #1420 review a): a destination and a token must never be
// observable as a mixed pair (the NEW destination with the OLD token), not by
// a launch during a save, not by a restart at any point in it, and not after a
// failed rollback. On any doubt: no secret.
describe('destination/secret pairing never mixes (#1304, q110)', () => {
  type Store = {
    get: (serverId: string, inputId: string) => Promise<string | null>
    set: (serverId: string, inputId: string, value: string) => Promise<void>
    clearServer: (serverId: string) => Promise<void>
  }
  const storeOf = (svc: UserMcpService) => (svc as unknown as { secrets: Store }).secrets
  const EVIL = 'https://evil.example/mcp'
  const moved = (id: string, extra: Partial<UserMcpSaveInput> = {}): UserMcpSaveInput => beeper({
    id,
    entry: { type: 'http', url: EVIL, headers: { Authorization: 'Bearer ${input:beeper-authorization}' } },
    secrets: {},
    ...extra,
  } as Partial<UserMcpSaveInput>)
  const launch = (svc: UserMcpService) => svc.resolveForLaunch({ provider: 'claude', overrides: {}, cwd: dir })
  const mixed = (resolution: Awaited<ReturnType<UserMcpService['resolveForLaunch']>>) =>
    resolution.servers.some(server => JSON.stringify(server.entry).includes('evil.example') && Object.values(server.secrets).includes(TOKEN))
  const deferred = () => { let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve }); return { gate, release } }

  async function seeded() {
    const live = service()
    expect((await live.save(beeper())).ok).toBe(true)
    return { live, id: (await live.snapshot()).servers[0]!.id }
  }

  it.each(['clearServer', 'set', 'prune'] as const)(
    'a launch and a restart while the save is paused at %s never pair the new destination with the old token',
    async method => {
      const { live, id } = await seeded()
      const store = storeOf(live) as unknown as Record<string, (...args: unknown[]) => Promise<void>>
      const real = store[method]!.bind(store)
      const hold = deferred()
      let reached!: () => void
      const atStep = new Promise<void>(resolve => { reached = resolve })
      store[method] = async (...args) => { reached(); await hold.gate; return real(...args) }
      const saving = live.save(moved(id, method === 'set' ? { secrets: { 'beeper-authorization': 'bpr_live_new_token_1111' } } as Partial<UserMcpSaveInput> : {}))
      await Promise.race([atStep, saving])
      const liveLaunch = launch(live)
      expect(mixed(await launch(service()))).toBe(false)
      hold.release()
      await saving
      expect(mixed(await liveLaunch)).toBe(false)
      expect(mixed(await launch(service()))).toBe(false)
    },
  )

  it('a failed rollback write after a failed secret step never leaves the new destination with the old token', async () => {
    const { live, id } = await seeded()
    const store = storeOf(live)
    store.set = async () => {
      await chmod(dir, 0o500)
      throw new Error('secure storage unavailable')
    }
    try {
      expect((await live.save(moved(id, { secrets: { 'beeper-authorization': 'bpr_live_new_token_2222' } } as Partial<UserMcpSaveInput>))).ok).toBe(false)
    } finally {
      await chmod(dir, 0o700)
    }
    expect(mixed(await launch(service()))).toBe(false)
  })

  // The reverse mix: a launch that read the OLD destination and then awaited
  // its native policy lookups used to read the secret store AFTER a save had
  // written the NEW token, pairing the old destination with a token the user
  // meant for the new one. Launches are serialized with mutations.
  it('a launch paused in its own lookups never pairs the old destination with the new token', async () => {
    const { live, id } = await seeded()
    const hold = deferred()
    let reached!: () => void
    const inLookup = new Promise<void>(resolve => { reached = resolve })
    const gated = new UserMcpService({
      stateDir: dir,
      codec,
      native: {
        list: async () => native,
        codexNames: async () => codexNames,
        claudeManagedPolicy: async () => { reached(); await hold.gate; return false },
      },
    })
    const launching = gated.resolveForLaunch({ provider: 'claude', overrides: {}, cwd: dir })
    await inLookup
    const saving = gated.save(moved(id, { secrets: { 'beeper-authorization': 'bpr_live_new_token_4444' } } as Partial<UserMcpSaveInput>))
    await new Promise(resolve => setTimeout(resolve, 50))
    hold.release()
    const resolution = await launching
    await saving
    const reverseMix = resolution.servers.some(server =>
      JSON.stringify(server.entry).includes('localhost:23373') && Object.values(server.secrets).includes('bpr_live_new_token_4444'))
    expect(reverseMix).toBe(false)
    void live
  })

  // Review a: snapshotServer returned an EMPTY snapshot on any readdir error,
  // so a failed step then "restored" nothing and the server lost its token.
  // Only a missing directory means no secrets.
  it('a secrets directory that cannot be listed is an error, not an empty snapshot', async () => {
    const { live, id } = await seeded()
    const store = (live as unknown as { secrets: { snapshotServer: (id: string) => Promise<Map<string, Buffer>> } }).secrets
    const serverDir = join(dir, 'mcp-secrets', id)
    await chmod(serverDir, 0o000)
    try {
      await expect(store.snapshotServer(id)).rejects.toThrow()
    } finally {
      await chmod(serverDir, 0o700)
    }
    await expect(store.snapshotServer('never-saved')).resolves.toEqual(new Map())
  })

  // Worker rule "unknown is never empty" (q109, q115): through the SERVICE, on
  // the real filesystem. A save that cannot list the secrets directory must
  // fail without touching the stored bytes. After the permission comes back,
  // routine maintenance (a save that changes no secret, which prunes) must
  // keep the same ciphertext, and a launch still gets the original token.
  // WHY both this and the snapshotServer test above: on a real filesystem an
  // unlistable directory also blocks the write and the rm, so an "empty on any
  // error" snapshot cannot do damage HERE. It does damage on a transient
  // EMFILE/EIO, which no real fs reproduces on demand. The test above is the
  // one that fails when snapshotServer treats a non-ENOENT error as empty.
  it('an unlistable secrets directory fails the save once and the token bytes survive recovery and maintenance', async () => {
    const { live, id } = await seeded()
    const serverDir = join(dir, 'mcp-secrets', id)
    const [blob] = await readdir(serverDir)
    const before = await readFile(join(serverDir, blob!))
    await chmod(serverDir, 0o000)
    try {
      const failed = await live.save(beeper({ id, secrets: { 'beeper-authorization': 'bpr_live_new_token_5555' } } as Partial<UserMcpSaveInput>))
      expect(failed.ok).toBe(false)
    } finally {
      await chmod(serverDir, 0o700)
    }
    expect(await readFile(join(serverDir, blob!))).toEqual(before)
    const maintained = await live.save(beeper({ id, name: 'beeper-renamed', secrets: {} } as Partial<UserMcpSaveInput>))
    expect(maintained.ok).toBe(true)
    expect(await readFile(join(serverDir, blob!))).toEqual(before)
    expect(await launchedToken(service(), id)).toBe(TOKEN)
  })

  it('a listener that throws after commit does not turn a committed save into a failure', async () => {
    const { live, id } = await seeded()
    live.onChange(() => { throw new Error('broadcast failed') })
    const result = await live.save(beeper({ id, secrets: { 'beeper-authorization': 'bpr_live_new_token_3333' } } as Partial<UserMcpSaveInput>))
    expect(result.ok).toBe(true)
    expect(await launchedToken(service(), id)).toBe('bpr_live_new_token_3333')
  })
})


// q113 (SECURITY, #1420 fresh review a): ORDER alone cannot hold the pairing
// across a crash or a failed restore. A/T -> B/U with a failing prune rolled
// the document back to A before U was removed, and a restart (or a failed
// restore) then launched A with U. Each secret record is now bound to the
// destination it was saved for, and a launch refuses a secret whose binding
// does not match the document's current destination: fail closed, in both
// directions, whatever state a crash or a failed restore leaves.
describe('secrets are bound to their destination (#1304, q113)', () => {
  type Store = Record<string, (...args: unknown[]) => Promise<unknown>>
  const storeOf = (svc: UserMcpService) => (svc as unknown as { secrets: Store }).secrets
  const OLD_URL = 'http://localhost:23373/v0/mcp'
  const NEW_URL = 'https://evil.example/mcp'
  const U = 'bpr_live_new_token_9999'
  const deferred = () => { let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve }); return { gate, release } }
  const at = (url: string) => ({ type: 'http', url, headers: { Authorization: 'Bearer ${input:beeper-authorization}' } })
  async function pairing(svc: UserMcpService) {
    const resolution = await svc.resolveForLaunch({ provider: 'claude', overrides: {}, cwd: dir })
    return resolution.servers.map(server => [server.entry.type === 'http' ? (server.entry as { url: string }).url : '', server.secrets['beeper-authorization'] ?? null])
  }
  const wrongPair = (pairs: Array<Array<string | null>>) =>
    pairs.some(([url, token]) => (url === OLD_URL && token === U) || (url === NEW_URL && token === TOKEN))

  async function seeded() {
    const live = service()
    expect((await live.save(beeper())).ok).toBe(true)
    return { live, id: (await live.snapshot()).servers[0]!.id }
  }

  it('a restart between the document rollback and the secret restore never launches the old address with the new token', async () => {
    const { live, id } = await seeded()
    const store = storeOf(live)
    store.prune = async () => { throw new Error('prune failed') }
    const realRestore = store.restoreServer!.bind(store)
    const hold = deferred()
    let reached!: () => void
    const atRestore = new Promise<void>(resolve => { reached = resolve })
    store.restoreServer = async (...args) => { reached(); await hold.gate; return realRestore(...args) }
    const saving = live.save(beeper({ id, entry: at(NEW_URL), secrets: { 'beeper-authorization': U } } as Partial<UserMcpSaveInput>))
    await atRestore
    expect(wrongPair(await pairing(service()))).toBe(false)
    hold.release()
    expect((await saving).ok).toBe(false)
    expect(wrongPair(await pairing(service()))).toBe(false)
  })

  it('a failed secret restore never leaves the old address with the new token', async () => {
    const { live, id } = await seeded()
    const store = storeOf(live)
    store.prune = async () => { throw new Error('prune failed') }
    store.restoreServer = async () => { throw new Error('restore failed') }
    expect((await live.save(beeper({ id, entry: at(NEW_URL), secrets: { 'beeper-authorization': U } } as Partial<UserMcpSaveInput>))).ok).toBe(false)
    expect(wrongPair(await pairing(live))).toBe(false)
    expect(wrongPair(await pairing(service()))).toBe(false)
  })

  it('a token written for one destination is refused for another, read from disk after a restart', async () => {
    const { live, id } = await seeded()
    // Hand-craft the worst durable state: the document names the NEW address
    // while the blob still holds the token saved for the OLD one.
    const snapshotOld = await storeOf(live).snapshotServer!(id) as Map<string, Buffer>
    expect((await live.save(beeper({ id, entry: at(NEW_URL), secrets: {} } as Partial<UserMcpSaveInput>))).ok).toBe(true)
    await storeOf(live).restoreServer!(id, snapshotOld)
    const restarted = service()
    expect(await launchedToken(restarted, id)).toBeNull()
    expect(wrongPair(await pairing(restarted))).toBe(false)
  })

  // q114: a record written before binding carries no proof of which
  // destination it was saved for. An old-version crash could leave document B
  // with the plaintext token T that was entered for A, and an upgrade that
  // bound legacy records to "the destination the document names" labelled T
  // as B and launched B/T. Legacy records are therefore never trusted: they
  // read as not set until the user re-enters them, across every restart.
  it('never launches a pre-binding secret, even when the document names a destination', async () => {
    const live = service()
    expect((await live.save(beeper({ entry: at(NEW_URL), secrets: {} } as Partial<UserMcpSaveInput>))).ok).toBe(true)
    const id = (await live.snapshot()).servers[0]!.id
    await mkdir(join(dir, 'mcp-secrets', id), { recursive: true })
    await writeFile(join(dir, 'mcp-secrets', id, 'beeper-authorization.bin'), codec.encrypt(TOKEN), { mode: 0o600 })
    expect(await launchedToken(service(), id)).toBeNull()
    expect(await launchedToken(service(), id)).toBeNull()
  })

  // B6 (q114): kept, withheld, and bound only by the user's confirmation.
  it('keeps a pre-binding secret, withholds it, and binds it only when the user confirms it', async () => {
    const live = service()
    expect((await live.save(beeper({ entry: at(NEW_URL), secrets: {} } as Partial<UserMcpSaveInput>))).ok).toBe(true)
    const id = (await live.snapshot()).servers[0]!.id
    const blob = join(dir, 'mcp-secrets', id, 'beeper-authorization.bin')
    await mkdir(join(dir, 'mcp-secrets', id), { recursive: true })
    await writeFile(blob, codec.encrypt(TOKEN), { mode: 0o600 })
    const restarted = service()
    expect(await launchedToken(restarted, id)).toBeNull()
    expect((await restarted.snapshot()).servers[0]!.secrets['beeper-authorization']).toMatchObject({ set: false, unconfirmed: true })
    expect(await readFile(blob, 'utf8')).toBe(`enc:${TOKEN}`)
    expect((await restarted.confirmSecret(id, 'beeper-authorization')).ok).toBe(true)
    expect(await launchedToken(service(), id)).toBe(TOKEN)
  })

  it('tells the user a pre-binding secret must be re-entered, and accepts the re-entry', async () => {
    const live = service()
    expect((await live.save(beeper({ secrets: {} } as Partial<UserMcpSaveInput>))).ok).toBe(true)
    const id = (await live.snapshot()).servers[0]!.id
    await mkdir(join(dir, 'mcp-secrets', id), { recursive: true })
    await writeFile(join(dir, 'mcp-secrets', id, 'beeper-authorization.bin'), codec.encrypt(TOKEN), { mode: 0o600 })
    const restarted = service()
    const [server] = (await restarted.snapshot()).servers
    expect(server!.problems.map(problem => problem.message).join(' ')).toMatch(/earlier version.*re-enter/i)
    expect((await restarted.setSecret(id, 'beeper-authorization', TOKEN)).ok).toBe(true)
    expect(await launchedToken(service(), id)).toBe(TOKEN)
  })

  it('restores ciphertext with owner-only permissions', async () => {
    const { live, id } = await seeded()
    const store = storeOf(live)
    const snapshot = await store.snapshotServer!(id) as Map<string, Buffer>
    await store.restoreServer!(id, snapshot)
    expect((await stat(join(dir, 'mcp-secrets', id, 'beeper-authorization.bin'))).mode & 0o777).toBe(0o600)
  })

  it('a launch requested while a save is running waits for that save', async () => {
    const { live, id } = await seeded()
    const store = storeOf(live)
    const realClear = store.clearServer!.bind(store)
    const hold = deferred()
    let reached!: () => void
    const atClear = new Promise<void>(resolve => { reached = resolve })
    store.clearServer = async (...args) => { reached(); await hold.gate; return realClear(...args) }
    const saving = live.save(beeper({ id, entry: at(NEW_URL), secrets: { 'beeper-authorization': U } } as Partial<UserMcpSaveInput>))
    await atClear
    let launched = false
    const launching = pairing(live).then(result => { launched = true; return result })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(launched).toBe(false)
    hold.release()
    await saving
    expect(await launching).toEqual([[NEW_URL, U]])
  })
})

// #1420 reviews a+b (blocker): an agent changing the endpoint INSIDE a
// secret-bearing env value kept the token, stayed enabled without review, and
// the next launch sent the token to the new host.
describe('an endpoint inside a secret-bearing value is part of the destination (#1420)', () => {
  const stdio = (endpoint: string) => ({
    name: 'endpoint-client',
    enabled: true,
    providers: { claude: true, codex: true },
    entry: { command: 'node', args: ['client.js'], env: { MCP_ENDPOINT: endpoint } },
    inputs: [{ id: 'beeper-authorization', description: 'Token' }],
  })

  it('an agent that moves the endpoint loses the token and needs review, across a restart', async () => {
    const live = service()
    expect((await live.save({ ...stdio('https://trusted.example/mcp?key=${input:beeper-authorization}'), secrets: { 'beeper-authorization': TOKEN } } as UserMcpSaveInput)).ok).toBe(true)
    const id = (await live.snapshot()).servers[0]!.id
    const moved = await live.save({ id, ...stdio('https://evil.example/mcp?key=${input:beeper-authorization}') } as UserMcpSaveInput, 'agent')
    expect(moved.ok).toBe(true)
    const restarted = service()
    const [server] = (await restarted.snapshot()).servers
    expect(server!.pendingReview).toBe(true)
    const resolution = await restarted.resolveForLaunch({ provider: 'claude', overrides: {}, cwd: dir })
    expect(JSON.stringify(resolution.servers)).not.toContain(TOKEN)
  })
})

