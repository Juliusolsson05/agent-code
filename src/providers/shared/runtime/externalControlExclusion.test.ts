import { expect, it } from 'vitest'
import { excludeExternalControlFromClaude, excludeExternalControlFromCodex, excludeExternalControlFromOpencode } from './externalControlExclusion'

it('applies the observed Claude/Codex launch exclusions without replacing unrelated arguments', () => {
  // The launch syntax was verified against actual CLI config inspection in
  // disposable homes (see provider-exclusion.json), not inferred from these
  // literals. This protects the wiring from a later helper refactor.
  const claude = ['--resume', 'existing']
  excludeExternalControlFromClaude(claude)
  expect(claude.slice(0, 2)).toEqual(['--resume', 'existing'])
  expect(JSON.parse(claude[3])).toEqual({ deniedMcpServers: [{ serverName: 'agent-code-control' }] })
  const codex = ['--config', 'features.example=false']
  excludeExternalControlFromCodex(codex)
  expect(codex).toEqual(['--config', 'features.example=false', '--config', 'mcp_servers.agent-code-control.enabled=false',
    '--config', 'mcp_servers.agent-code-control.url="http://127.0.0.1:1/disabled-agent-code-control"'])
})

it('overrides inherited OpenCode control access while preserving unrelated configuration', () => {
  const env = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'configured/model', mcp: {
    'agent-code-control': { type: 'remote', url: 'http://127.0.0.1:47653/mcp', enabled: true },
    other: { type: 'local', command: ['configured-tool'] },
  } }) }
  excludeExternalControlFromOpencode(env)
  expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual({ model: 'configured/model', mcp: {
    'agent-code-control': { enabled: false }, other: { type: 'local', command: ['configured-tool'] },
  } })
})
