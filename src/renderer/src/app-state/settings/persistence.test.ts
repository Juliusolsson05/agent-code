import { describe, expect, it } from 'vitest'

import { coerceSettings } from '@renderer/app-state/settings/persistence'

describe('coerceSettings agentViewMode', () => {
  it('defaults missing agentViewMode to Agent mode', () => {
    expect(coerceSettings({}).agentViewMode).toBe('agent')
  })

  it('keeps valid agentViewMode values', () => {
    expect(coerceSettings({ agentViewMode: 'terminal' }).agentViewMode).toBe('terminal')
    expect(coerceSettings({ agentViewMode: 'hybrid' }).agentViewMode).toBe('hybrid')
  })

  it('falls back to Agent mode for invalid agentViewMode values', () => {
    expect(coerceSettings({ agentViewMode: 'feed-but-sometimes' }).agentViewMode).toBe('agent')
  })

  it('defaults missing savedPromptTemplates to an empty list', () => {
    expect(coerceSettings({}).savedPromptTemplates).toEqual([])
  })

  it('defaults missing built-in MCP defaults to an empty list', () => {
    expect(coerceSettings({}).defaultBuiltInMcpDomains).toEqual([])
  })

  it('keeps only configurable built-in MCP defaults in first-seen order', () => {
    expect(coerceSettings({
      defaultBuiltInMcpDomains: [
        'workflows',
        'ping',
        'orchestration',
        'workflows',
        'not-a-domain',
        12,
      ],
    }).defaultBuiltInMcpDomains).toEqual(['workflows', 'orchestration'])
  })
})
