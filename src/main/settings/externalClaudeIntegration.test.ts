import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createExternalClaudeIntegration } from './externalClaudeIntegration'
import { createExternalCodexIntegration } from './externalCodexIntegration'
import { createExternalControlSettings } from './externalControl'

// Shaped like a real ~/.claude.json as Claude itself saves it (2-space JSON,
// no trailing newline): auth, counters, a user-scope server and a
// project-scoped one. Every value is synthetic, and no user file was copied.
const claudeFile = JSON.stringify({
  numStartups: 412,
  oauthAccount: { accountUuid: '00000000-0000-0000-0000-000000000000', emailAddress: 'fixture@example.invalid' },
  hasCompletedOnboarding: true,
  mcpServers: { other: { type: 'stdio', command: 'other-tool', args: [] } },
  projects: { '/work/repo': { allowedTools: [], mcpServers: { 'agent-code-control': { type: 'stdio', command: 'project-owned' } } } },
}, null, 2)
const server = async (path: string) => JSON.parse(await readFile(path, 'utf8')).mcpServers['agent-code-control']
const tokenA = 'a'.repeat(64)
const tokenB = 'b'.repeat(64)

it('installs, rotates and removes only the user-scope operator entry and skill, leaving every other byte alone', async () => {
  const home = await mkdtemp(join(tmpdir(), 'external-claude-'))
  try {
    const source = await readFile(join(process.cwd(), 'operator-skills/agent-code-computer-execution/SKILL.md'), 'utf8')
    const integration = createExternalClaudeIntegration({ home }, source)
    // CLAUDE_CONFIG_DIR unset: Claude's FILE is ~/.claude.json, skills are ~/.claude/skills.
    expect(integration.configPath).toBe(join(home, '.claude.json'))
    expect(integration.skillPath).toBe(join(home, '.claude', 'skills', 'agent-code-computer-execution', 'SKILL.md'))
    await writeFile(integration.configPath, claudeFile)

    await integration.reconcile({ url: 'http://127.0.0.1:47653/mcp', token: tokenA })
    const enabled = JSON.parse(await readFile(integration.configPath, 'utf8'))
    expect(enabled.mcpServers['agent-code-control']).toEqual({ type: 'http', url: 'http://127.0.0.1:47653/mcp', headers: { Authorization: `Bearer ${tokenA}` } })
    // Everything else, including a PROJECT-scoped server under the same name, is untouched.
    const { mcpServers: _ours, ...rest } = enabled
    const { mcpServers: _theirs, ...original } = JSON.parse(claudeFile)
    expect(rest).toEqual(original)
    expect(enabled.mcpServers.other).toEqual({ type: 'stdio', command: 'other-tool', args: [] })
    expect((await stat(integration.configPath)).mode & 0o777).toBe(0o600)
    expect(await readFile(integration.skillPath, 'utf8')).toContain(source)
    await expect(stat(`${integration.configPath}.lock`)).rejects.toMatchObject({ code: 'ENOENT' })

    // App upgrade (new skill text) + key rotation + port change.
    const upgraded = createExternalClaudeIntegration({ home }, source + '\nUpdated guide.\n')
    await upgraded.reconcile({ url: 'http://127.0.0.1:47654/mcp', token: tokenB })
    expect(await server(integration.configPath)).toEqual({ type: 'http', url: 'http://127.0.0.1:47654/mcp', headers: { Authorization: `Bearer ${tokenB}` } })
    expect(await readFile(integration.configPath, 'utf8')).not.toContain(tokenA)

    await upgraded.reconcile(null)
    // Claude-formatted input round-trips exactly: no credential, no reformatting.
    expect(await readFile(integration.configPath, 'utf8')).toBe(claudeFile)
    await expect(readFile(integration.skillPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await upgraded.reconcile(null)
    expect(await readFile(integration.configPath, 'utf8')).toBe(claudeFile)
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('honours CLAUDE_CONFIG_DIR and never creates Claude\'s config file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'external-claude-dir-'))
  try {
    const configDir = join(home, 'custom-claude')
    const integration = createExternalClaudeIntegration({ home, claudeConfigDir: configDir }, 'guide')
    expect(integration.configPath).toBe(join(configDir, '.claude.json'))
    expect(integration.skillPath).toBe(join(configDir, 'skills', 'agent-code-computer-execution', 'SKILL.md'))
    await integration.reconcile(null)
    await expect(stat(integration.configPath)).rejects.toMatchObject({ code: 'ENOENT' })
    // A file holding only our server would stop Claude offering its backup
    // restore for a lost .claude.json, so a missing file is reported instead.
    await expect(integration.reconcile({ url: 'http://127.0.0.1:47653/mcp', token: tokenA })).rejects.toThrow('start Claude Code once')
    await expect(stat(integration.configPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(integration.skillPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await mkdir(configDir, { recursive: true })
    await writeFile(integration.configPath, '{}')
    await integration.reconcile({ url: 'http://127.0.0.1:47653/mcp', token: tokenA })
    expect(await server(integration.configPath)).toMatchObject({ type: 'http' })
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('adopts a hand-pasted copy of our connection but refuses anything the user built under the reserved name', async () => {
  const home = await mkdtemp(join(tmpdir(), 'external-claude-owner-'))
  try {
    const integration = createExternalClaudeIntegration({ home }, 'guide')
    // What "Copy JSON Config" and `claude mcp add --transport http … --header` store.
    const pasted = JSON.stringify({ mcpServers: { 'agent-code-control': { type: 'http', url: 'http://127.0.0.1:47653/mcp', headers: { Authorization: `Bearer ${tokenA}` } } } }, null, 2)
    await writeFile(integration.configPath, pasted)
    await integration.reconcile({ url: 'http://127.0.0.1:47653/mcp', token: tokenB })
    expect((await server(integration.configPath)).headers.Authorization).toBe(`Bearer ${tokenB}`)
    await integration.reconcile(null)

    for (const userBuilt of [
      { type: 'stdio', command: 'my-own-bridge' },
      { type: 'http', url: 'https://remote.example.invalid/mcp', headers: { Authorization: `Bearer ${tokenA}` } },
      { type: 'http', url: 'http://127.0.0.1:47653/mcp', headers: { Authorization: `Bearer ${tokenA}` }, headersHelper: '/bin/my-helper' },
    ]) {
      const text = JSON.stringify({ mcpServers: { 'agent-code-control': userBuilt } }, null, 2)
      await writeFile(integration.configPath, text)
      await expect(integration.reconcile({ url: 'http://127.0.0.1:47653/mcp', token: tokenB })).rejects.toThrow('unmanaged')
      expect(await readFile(integration.configPath, 'utf8')).toBe(text)
      // Validation runs before the skill install, so a conflict leaves no half.
      await expect(stat(integration.skillPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }

    await writeFile(integration.configPath, '{ "oauthAccount": "trunc')
    const invalid = integration.reconcile({ url: 'http://127.0.0.1:47653/mcp', token: tokenB })
    await expect(invalid).rejects.toThrow('not valid JSON')
    // The diagnostic must not echo file contents (it reaches Settings/history).
    await expect(invalid).rejects.not.toThrow('oauthAccount')
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('waits for a live Claude config lock, clears an abandoned one, and gives up on one that stays busy', async () => {
  const home = await mkdtemp(join(tmpdir(), 'external-claude-lock-'))
  try {
    const integration = createExternalClaudeIntegration({ home }, 'guide')
    const lock = `${integration.configPath}.lock`
    await writeFile(integration.configPath, claudeFile)

    // A running Claude holds the lock briefly; we must wait, not write past it.
    await mkdir(lock)
    let written = false
    const pending = integration.reconcile({ url: 'http://127.0.0.1:47653/mcp', token: tokenA }).then(() => { written = true })
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(written).toBe(false)
    expect(await readFile(integration.configPath, 'utf8')).toBe(claudeFile)
    await rm(lock, { recursive: true })
    await pending
    expect(await server(integration.configPath)).toMatchObject({ type: 'http' })

    // proper-lockfile treats a lock older than 10s as abandoned; so do we.
    await mkdir(lock)
    const old = new Date(Date.now() - 60_000)
    await utimes(lock, old, old)
    await integration.reconcile(null)
    expect(await readFile(integration.configPath, 'utf8')).toBe(claudeFile)
    await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })

    await mkdir(lock)
    await expect(integration.reconcile({ url: 'http://127.0.0.1:47653/mcp', token: tokenA })).rejects.toThrow('busy')
    expect(await readFile(integration.configPath, 'utf8')).toBe(claudeFile)
    // Nothing to change (every app start while disabled): Claude's lock is not
    // taken at all, because holding it pushes Claude onto its unlocked path.
    await integration.reconcile(null)
    expect((await stat(lock)).isDirectory()).toBe(true)
  } finally { await rm(home, { recursive: true, force: true }) }
}, 10_000)

it('keeps the listener for one client when the other conflicts, and removes a deselected client\'s files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'external-clients-'))
  const codex = createExternalCodexIntegration(join(home, '.codex'), 'guide')
  const claude = createExternalClaudeIntegration({ home }, 'guide')
  let running = false
  const settings = createExternalControlSettings(join(home, 'app'), {
    integrations: [codex, claude], start: async port => { running = true; return port }, stop: async () => { running = false }, copy() {},
  })
  const configure = (input: Record<string, unknown>) => settings.capabilities.find(x => x.descriptor.id === 'externalControl.configure')!.execute(input, {
    requestId: 'local', caller: { kind: 'application', id: 'window' }, owner: { kind: 'main', generation: 'one' },
  })
  try {
    await settings.initialize()
    // Both clients are selected by default, including for pre-#1539 settings files.
    expect(settings.status()).toMatchObject({ codex: { selected: true }, claude: { selected: true } })

    await writeFile(claude.configPath, JSON.stringify({ mcpServers: { 'agent-code-control': { type: 'stdio', command: 'mine' } } }))
    await configure({ enabled: true })
    expect(running).toBe(true)
    expect(settings.status()).toMatchObject({ error: null, codex: { managed: true, error: null }, claude: { managed: false } })
    expect(settings.status().claude?.error).toContain('unmanaged')
    expect(await readFile(codex.configPath, 'utf8')).toContain('agent-code-control')

    // Every SELECTED client failing is the old single-client rule: stop listening.
    await configure({ enabled: true, clients: { codex: false } })
    expect(running).toBe(false)
    expect(settings.status().error).toContain('claude:')
    // Deselecting Codex removed our connection and skill from it.
    expect(await readFile(codex.configPath, 'utf8')).not.toContain('agent-code-control')
    await expect(stat(codex.skillPath)).rejects.toMatchObject({ code: 'ENOENT' })

    await writeFile(claude.configPath, '{}')
    await configure({ enabled: true, clients: { codex: true } })
    expect(settings.status()).toMatchObject({ running: true, codex: { managed: true }, claude: { managed: true } })
    await configure({ enabled: true, clients: { claude: false } })
    expect(await server(claude.configPath)).toBeUndefined()
    await expect(stat(claude.skillPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(settings.status()).toMatchObject({ running: true, codex: { managed: true }, claude: { selected: false, managed: false } })

    // The selection survives a restart.
    const restarted = createExternalControlSettings(join(home, 'app'), {
      integrations: [codex, claude], start: async port => port, stop: async () => {}, copy() {},
    })
    await restarted.initialize()
    expect(restarted.status()).toMatchObject({ codex: { selected: true }, claude: { selected: false } })
    await restarted.dispose()
  } finally { await settings.dispose(); await rm(home, { recursive: true, force: true }) }
})
