import { describe, expect, it } from 'vitest'

import { isAgentSpawnToolName } from './agentSpawnTools'

describe('isAgentSpawnToolName (P2c dispatch-name blind spot)', () => {
  it('matches all three spawn families', () => {
    expect(isAgentSpawnToolName('Agent')).toBe(true)
    expect(isAgentSpawnToolName('spawn_agent')).toBe(true)
    expect(isAgentSpawnToolName('orchestration_create_agent')).toBe(true)
    expect(isAgentSpawnToolName('mcp__agent_code__orchestration_create_agent')).toBe(true)
  })
  it('rejects fleet QUERIES and everything else', () => {
    expect(isAgentSpawnToolName('wait_agent')).toBe(false)
    expect(isAgentSpawnToolName('mcp__agent_code__orchestration_wait_agents')).toBe(false)
    expect(isAgentSpawnToolName('orchestration_read_agent')).toBe(false)
    expect(isAgentSpawnToolName('Bash')).toBe(false)
  })
})
