import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from '@iarna/toml'
import { expect, it } from 'vitest'
import { createExternalCodexIntegration } from './externalCodexIntegration'

// Captured from #817's real configuration: only the operator table structure
// and approval policy remain; URL/token are synthetic and no other user config
// is recorded. The marker hashes the original connection, before Codex's tool
// settings were inserted, exactly as in the failing local file.
const fixture = () => readFile(join(process.cwd(), 'testing/fixtures/external-control/codex-tool-approvals.toml'), 'utf8')
const server = (config: string) => (parse(config).mcp_servers as Record<string, Record<string, unknown>>)['agent-code-control']

it('recovers observed tool approval additions and preserves their bytes through retry, rotation, disable and re-enable', async () => {
  const home = await mkdtemp(join(tmpdir(), 'operator-policy-'))
  try {
    const recorded = await fixture()
    const policy = recorded.slice(recorded.indexOf('\n[mcp_servers.agent-code-control.tools.'), recorded.indexOf('# /agent-code-external-control'))
    const unrelated = '# Preserve unrelated formatting\nmodel = "gpt-6"\n[mcp_servers.other]\nurl = "http://127.0.0.1:9/mcp"\n'
    const integration = createExternalCodexIntegration(home, 'operator guide')
    await writeFile(integration.configPath, unrelated + recorded)
    await integration.reconcile({ url: 'http://127.0.0.1:47653/mcp', token: 'fixture-only-token' })
    const migrated = await readFile(integration.configPath, 'utf8')
    expect(migrated.startsWith(unrelated)).toBe(true)
    expect(migrated).toContain(policy)
    expect(server(migrated)).toEqual(server(recorded))
    // The new ownership boundary ends before user policy, so later policy edits
    // are legal without teaching the integration each tool's name or enum.
    expect(migrated.indexOf('# /agent-code-external-control')).toBeLessThan(migrated.indexOf('[mcp_servers.agent-code-control.tools.'))
    const edited = migrated.replace('ac_agents_prompt]', 'ac_agents_prompt_renamed]')
    await writeFile(integration.configPath, edited)
    const restarted = createExternalCodexIntegration(home, 'updated guide')
    const rotated = { url: 'http://127.0.0.1:47654/mcp', token: 'rotated-fixture-token' }
    await restarted.reconcile(rotated)
    const afterRotation = await readFile(integration.configPath, 'utf8')
    expect(server(afterRotation).tools).toEqual(server(edited).tools)
    expect(afterRotation).not.toContain('fixture-only-token')
    await restarted.reconcile(rotated)
    expect(await readFile(integration.configPath, 'utf8')).toBe(afterRotation)
    await restarted.reconcile(null)
    const disabled = await readFile(integration.configPath, 'utf8')
    expect(server(disabled)).toEqual({ url: rotated.url, enabled: false, tools: server(edited).tools })
    expect(disabled).not.toContain(rotated.token)
    await expect(readFile(integration.skillPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await restarted.reconcile(null)
    expect(await readFile(integration.configPath, 'utf8')).toBe(disabled)
    await restarted.reconcile(rotated)
    expect(server(await readFile(integration.configPath, 'utf8'))).toEqual({ url: rotated.url,
      http_headers: { Authorization: `Bearer ${rotated.token}` }, tools: server(edited).tools })
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('does not adopt changed connection credentials alongside otherwise valid tool policy', async () => {
  const home = await mkdtemp(join(tmpdir(), 'operator-policy-conflict-'))
  try {
    const integration = createExternalCodexIntegration(home, 'guide')
    const changed = (await fixture()).replace('fixture-only-token', 'user-edited-token')
    await writeFile(integration.configPath, changed)
    await expect(integration.reconcile({ url: 'http://127.0.0.1:47653/mcp', token: 'new-token' })).rejects.toThrow('was edited')
    expect(await readFile(integration.configPath, 'utf8')).toBe(changed)
    await expect(readFile(integration.skillPath)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('preserves unrelated tables after the observed policies without changing their TOML ownership', async () => {
  const { reconcileExternalCodexConfig } = await import('./externalCodexConfig')
  const recorded = await fixture()
  const suffix = '\n[mcp_servers.other]\nurl = "http://example.invalid/mcp"\n# user comment\n[[skills.config]]\npath = "/my/skill"\nenabled = false\n'
  const original = recorded + suffix
  const next = reconcileExternalCodexConfig(original, { url: 'http://127.0.0.1:47653/mcp', token: 'fixture-only-token' })
  expect(next.endsWith(suffix)).toBe(true)
  expect(parse(next)).toEqual(parse(original))
})

it('rejects marker-shaped multiline string contents and bare keys whose scope removal would change', async () => {
  const { reconcileExternalCodexConfig } = await import('./externalCodexConfig')
  const recorded = await fixture()
  const fakeMarker = `memo = '''\n${recorded}'''\n[mcp_servers.agent-code-control]\nurl = "http://127.0.0.1:47653/mcp"\nhttp_headers = { Authorization = "Bearer fixture-only-token" }\n`
  const changedScope = recorded.replace('\n[mcp_servers.agent-code-control.tools.ac_agents_prompt]', '\nenabled = false\n[mcp_servers.agent-code-control.tools.ac_agents_prompt]')
  // These are valid TOML, so rejection proves the semantic ownership check,
  // rather than accidentally relying on a parser syntax error for protection.
  expect(() => parse(fakeMarker)).not.toThrow()
  expect(() => parse(changedScope)).not.toThrow()
  for (const config of [fakeMarker, changedScope]) {
    expect(() => reconcileExternalCodexConfig(config, null)).toThrow('unrelated Codex configuration')
  }
})
