import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { assertAntigravityExternalControlExcluded } from './externalControl.js'

let root: string, home: string, work: string, global: string, local: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agy-policy-'))
  home = join(root, 'home')
  work = join(root, 'project')
  global = join(home, '.gemini/config')
  local = join(work, '.agents')
  await Promise.all([mkdir(global, { recursive: true }), mkdir(local, { recursive: true })])
})
afterEach(() => rm(root, { recursive: true, force: true }))
const inspect = () => assertAntigravityExternalControlExcluded(work, { HOME: home })
const reserved = (disabled: boolean) => JSON.stringify({ mcpServers: { 'agent-code-control': { command: '/usr/bin/true', disabled } } })

it('refuses an enabled global operator even if a workspace disables the same name and no pane MCP servers were granted', async () => {
  const file = join(global, 'mcp_config.json')
  await writeFile(file, '')
  await expect(inspect()).resolves.toBeUndefined()
  await writeFile(file, '// harmless fixture\n' + reserved(false))
  await writeFile(join(local, 'mcp_config.json'), reserved(true))
  await expect(Promise.all([inspect(), inspect()])).rejects.toThrow(/agent-code-control/)
  expect(await readFile(file, 'utf8')).toBe('// harmless fixture\n' + reserved(false))
  await writeFile(file, reserved(true))
  await expect(inspect()).resolves.toBeUndefined()
})

it('checks project and plugin MCP configurations without exposing configuration values', async () => {
  const plugin = join(global, 'plugins', 'test-plugin')
  await mkdir(plugin, { recursive: true })
  await writeFile(join(plugin, 'plugin.json'), '{"name":"test-plugin"}')
  await writeFile(join(plugin, 'mcp_config.json'), reserved(false))
  await expect(inspect()).rejects.toThrow(/agent-code-control/)
  await writeFile(join(global, 'config.json'), '{"plugins":{"test-plugin":{"enabled":false}}}')
  await expect(inspect()).resolves.toBeUndefined()
  await writeFile(join(local, 'mcp_config.json'), '{"mcpServers":{"other":{"command":"/usr/bin/true","serverUrl":"https://example.test"}}}')
  await expect(inspect()).resolves.toBeUndefined()
  await writeFile(join(local, 'mcp_config.json'), '{"mcpServers":{"bad":"sensitive malformed value')
  await expect(inspect()).rejects.toThrow(/could not verify/i)
  await expect(inspect()).rejects.not.toThrow(/sensitive/)
})
