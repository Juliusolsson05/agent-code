import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ExternalControlMcpHost } from '../externalControlMcp/host'
import { createExternalControlSettings } from './externalControl'
import { createExternalCodexIntegration } from './externalCodexIntegration'

it('starts the real MCP listener after recovering the observed approval config, and survives rotation before disabling', async () => {
  const home = await mkdtemp(join(tmpdir(), 'operator-policy-http-'))
  const appDirectory = join(home, 'app')
  const integration = createExternalCodexIntegration(join(home, 'codex'), 'isolated operator guide')
  const owner = { kind: 'main' as const, generation: 'policy-trial' }
  const context = { owner, caller: { kind: 'external' as const, id: 'policy-trial' }, requestId: 'status' }
  const host = new ExternalControlMcpHost({
    catalog: () => settings.capabilities.map(capability => ({ descriptor: capability.descriptor, owner })),
    invoke: request => settings.capabilities.find(capability => capability.descriptor.id === request.capabilityId)!.execute(request.input, context),
    recordTransport: async () => {},
  })
  const settings = createExternalControlSettings(appDirectory, {
    integration,
    // Production settings and host are exercised unchanged; only port allocation
    // uses an ephemeral socket so this trial cannot collide with the user's app.
    start: (_port, token) => host.start(0, token), stop: () => host.stop(), copy() {},
  })
  const clients: Client[] = []
  const connect = async (url: string, token: string) => {
    const client = new Client({ name: 'operator-policy-trial', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    return client
  }
  const configure = (enabled: boolean, rotateKey = false) => settings.capabilities.find(capability => capability.descriptor.id === 'externalControl.configure')!.execute({ enabled, rotateKey }, {
    ...context, caller: { kind: 'application', id: 'settings' },
  })
  try {
    await mkdir(appDirectory, { recursive: true })
    await mkdir(join(home, 'codex'))
    await writeFile(integration.configPath, await readFile(join(process.cwd(), 'testing/fixtures/external-control/codex-tool-approvals.toml'), 'utf8'))
    const token = 'a'.repeat(64)
    await writeFile(join(appDirectory, 'external-control.json'), JSON.stringify({ enabled: true, port: 47653, token }))
    await settings.initialize()
    expect(settings.status()).toMatchObject({ enabled: true, running: true, error: null, codex: { managed: true } })
    const client = await connect(settings.status().url!, token)
    expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['ac_external_control_status'])
    expect((await client.callTool({ name: 'ac_external_control_status', arguments: {} })).structuredContent).toMatchObject({ ok: true, value: { enabled: true, running: true, error: null } })
    await client.close()
    expect(await configure(true, true)).toMatchObject({ ok: true, value: { running: true, error: null } })
    const rotatedToken = JSON.parse(await readFile(join(appDirectory, 'external-control.json'), 'utf8')).token as string
    expect(rotatedToken).not.toBe(token)
    const url = settings.status().url!
    expect((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{}' })).status).toBe(401)
    const rotatedClient = await connect(url, rotatedToken)
    expect((await rotatedClient.listTools()).tools).toHaveLength(1)
    await rotatedClient.close()
    expect(await configure(false)).toMatchObject({ ok: true, value: { enabled: false, running: false, error: null } })
    await expect(fetch(url)).rejects.toThrow()
    const disabled = await readFile(integration.configPath, 'utf8')
    expect(disabled).toContain('approval_mode')
    expect(disabled).toContain('enabled = false')
    expect(disabled).not.toContain(rotatedToken)
  } finally {
    await Promise.allSettled(clients.map(client => client.close()))
    await settings.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
