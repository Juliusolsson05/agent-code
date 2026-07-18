import { describe, expect, it } from 'vitest'

import { isAgentSpawnTool } from './registry.renderer.capabilities'

const tool = (name: string, input: Record<string, unknown> = {}) => ({
  type: 'tool_use' as const,
  id: 'spawn-1',
  name,
  input,
})

describe('isAgentSpawnTool — provider/schema ownership', () => {
  it('recognizes complete native and Agent Code orchestration spawns', () => {
    expect(isAgentSpawnTool(
      tool('Agent', { subagent_type: 'Explore', description: 'audit', prompt: 'inspect' }),
      'claude',
    )).toBe(true)
    expect(isAgentSpawnTool(
      tool('spawn_agent', { task_name: 'audit', message: 'inspect' }),
      'codex',
    )).toBe(true)
    expect(isAgentSpawnTool(tool('orchestration_create_agent', {
      kind: 'codex',
      cwd: '/repo',
      title: 'audit',
      prompt: 'inspect',
      runId: 'run-1',
      role: 'reviewer',
    }), 'codex')).toBe(true)
    expect(isAgentSpawnTool(tool('mcp__agent_code__orchestration_create_agent', {
      kind: 'claude',
      cwd: '/repo',
      title: 'audit',
      runId: 'run-1',
      role: 'reviewer',
    }), 'claude')).toBe(true)
  })

  it('rejects incomplete name matches and another provider vocabulary', () => {
    expect(isAgentSpawnTool(tool('Agent'), 'claude')).toBe(false)
    expect(isAgentSpawnTool(tool('spawn_agent', { message: 'inspect' }), 'claude')).toBe(false)
    expect(isAgentSpawnTool(tool('wait_agent'), 'codex')).toBe(false)
  })

  it('does not claim open-world MCP servers or unrelated tools', () => {
    expect(isAgentSpawnTool(
      tool('mcp__external_fleet__orchestration_create_agent'),
      'claude',
    )).toBe(false)
    expect(isAgentSpawnTool(tool('orchestration_read_agent'), 'codex')).toBe(false)
    expect(isAgentSpawnTool(tool('Bash'), 'claude')).toBe(false)
  })
})
