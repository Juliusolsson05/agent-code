import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createExternalControlSettings } from './externalControl'

it('keeps connection state shared, disabled by default, private on disk and absent from SDK results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-settings-'))
  let active = false
  let clipboard = ''
  const receivedTokens: string[] = []
  const ports = { start: async (port: number, token: string) => { active = true; receivedTokens.push(token); return port }, stop: async () => { active = false }, copy: (text: string) => { clipboard = text } }
  const settings = createExternalControlSettings(directory, ports)
  const context = { requestId: 'settings', caller: { kind: 'application' as const, id: 'window-one' }, owner: { kind: 'main' as const, generation: 'one' } }
  const call = (id: string, input: unknown) => settings.capabilities.find(capability => capability.descriptor.id === id)!.execute(input, context)
  try {
    await settings.initialize()
    expect(settings.status()).toMatchObject({ enabled: false, running: false })
    await expect(readFile(join(directory, 'external-control.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const configured = await call('externalControl.configure', { enabled: true })
    expect(active).toBe(true)
    const persisted = JSON.parse(await readFile(join(directory, 'external-control.json'), 'utf8'))
    expect(persisted.token).toHaveLength(64)
    expect((await stat(join(directory, 'external-control.json'))).mode & 0o777).toBe(0o600)
    expect(JSON.stringify(configured)).not.toContain(persisted.token)
    expect(await call('externalControl.copyConnection', {})).toEqual({ ok: true, value: { copied: true } })
    expect(clipboard).toContain('mcp_servers.agent-code-control')
    expect(clipboard).toContain(persisted.token)
    await call('externalControl.configure', { enabled: true, rotateKey: true })
    expect(receivedTokens[1]).not.toBe(persisted.token)
    await call('externalControl.configure', { enabled: false })
    expect(active).toBe(false)
    const next = createExternalControlSettings(directory, ports)
    await next.initialize()
    expect(next.status()).toMatchObject({ enabled: false, running: false })
    expect(settings.capabilities.filter(capability => capability.descriptor.id !== 'externalControl.status').every(capability => capability.descriptor.visibility === 'application')).toBe(true)
    await next.dispose()
  } finally { await settings.dispose(); await rm(directory, { recursive: true, force: true }) }
})
