import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { parse } from '@iarna/toml'
import { createExternalCodexIntegration } from './externalCodexIntegration'
import { createExternalControlSettings } from './externalControl'

it('manages only owned global Codex bytes across rotation, upgrade, restart and disable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'external-codex-'))
  const source = await readFile(join(process.cwd(), 'operator-skills/agent-code-computer-execution/SKILL.md'), 'utf8')
  const integration = createExternalCodexIntegration(home, source)
  // The real config owner uses TOML with comments, quoted project paths and
  // unrelated server/skill rules. Preserve those bytes, not just their values.
  const existing = '# Keep my formatting\nmodel = "gpt-6"\n[mcp_servers.other]\nurl = "http://127.0.0.1:9/mcp"\n[[skills.config]]\npath = "/other/SKILL.md"\nenabled = false\n'
  try {
    await writeFile(integration.configPath, existing)
    await integration.reconcile({ url: 'http://127.0.0.1:47653/mcp', token: 'first-secret' })
    expect((await readFile(integration.configPath, 'utf8')).startsWith(existing)).toBe(true)
    expect((await stat(integration.configPath)).mode & 0o777).toBe(0o600)
    expect(await readFile(integration.skillPath, 'utf8')).toContain(source)
    const restarted = createExternalCodexIntegration(home, source + '\nUpdated guide.\n')
    await restarted.reconcile({ url: 'http://127.0.0.1:47654/mcp', token: 'rotated-secret' })
    const config = await readFile(integration.configPath, 'utf8')
    expect(config).not.toContain('first-secret')
    expect(parse(config).mcp_servers).toMatchObject({ other: { url: 'http://127.0.0.1:9/mcp' }, 'agent-code-control': { url: 'http://127.0.0.1:47654/mcp' } })
    await restarted.reconcile(null)
    expect(await readFile(integration.configPath, 'utf8')).toBe(existing)
    await expect(readFile(integration.skillPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await restarted.reconcile(null)
    await writeFile(integration.configPath, '[mcp_servers."agent-code-control"]\nurl="http://user-config/mcp"\n')
    await expect(restarted.reconcile({ url: 'http://127.0.0.1/mcp', token: 'secret' })).rejects.toThrow('unmanaged')
    await writeFile(integration.configPath, 'mcp_servers = {}\n')
    await expect(restarted.reconcile({ url: 'http://127.0.0.1/mcp', token: 'secret' })).rejects.toThrow('cannot be extended')
    await expect(readFile(integration.skillPath)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('refuses edited or symlinked destinations and stops the listener when managed setup cannot complete', async () => {
  const home = await mkdtemp(join(tmpdir(), 'external-codex-conflict-'))
  const integration = createExternalCodexIntegration(home, 'skill content')
  let running = false
  const settings = createExternalControlSettings(join(home, 'app'), {
    integration, start: async port => { running = true; return port }, stop: async () => { running = false }, copy() {},
  })
  const configure = (enabled: boolean) => settings.capabilities.find(x => x.descriptor.id === 'externalControl.configure')!.execute({ enabled }, {
    requestId: 'local', caller: { kind: 'application', id: 'window' }, owner: { kind: 'main', generation: 'one' },
  })
  try {
    await settings.initialize()
    await configure(true)
    expect(running).toBe(true)
    await writeFile(integration.skillPath, 'my edited skill')
    const result = await configure(false)
    expect(running).toBe(false)
    expect(JSON.stringify(result)).toContain('was edited')
    expect(await readFile(integration.skillPath, 'utf8')).toBe('my edited skill')
    await rm(integration.skillPath)
    const config = await readFile(integration.configPath, 'utf8')
    await writeFile(integration.configPath, config.replace('http://127.0.0.1:', 'http://localhost:'))
    await expect(integration.reconcile(null)).rejects.toThrow('was edited')
    await rm(integration.configPath)
    const target = join(home, 'user-file')
    await writeFile(target, 'user data')
    await symlink(target, integration.configPath)
    await expect(integration.reconcile(null)).rejects.toThrow('ordinary file')
    expect(await readFile(target, 'utf8')).toBe('user data')
  } finally { await settings.dispose(); await rm(home, { recursive: true, force: true }) }
})
