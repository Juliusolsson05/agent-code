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

  // Corner style is coerced for a sharper reason than the other enums here:
  // applyTheme looks the tier up by id and writes its four lengths onto <html>.
  // An id that resolves to nothing would write `undefined` four times and every
  // rounded surface in the app would resolve to an invalid value at once.
  it('falls back to the default corner style for values it cannot resolve', () => {
    expect(coerceSettings({}).cornerStyle).toBe('round')
    expect(coerceSettings({ cornerStyle: 'squircle' }).cornerStyle).toBe('round')
    expect(coerceSettings({ cornerStyle: 7 }).cornerStyle).toBe('round')
  })

  it('keeps valid corner styles', () => {
    expect(coerceSettings({ cornerStyle: 'sharp' }).cornerStyle).toBe('sharp')
    expect(coerceSettings({ cornerStyle: 'soft' }).cornerStyle).toBe('soft')
  })

  it('defaults missing savedPromptTemplates to an empty list', () => {
    expect(coerceSettings({}).savedPromptTemplates).toEqual([])
  })

  it('keeps prompt templates out of command search unless explicitly enabled', () => {
    expect(coerceSettings({}).promptTemplatesInCommandSearchEnabled).toBe(false)
    expect(coerceSettings({ promptTemplatesInCommandSearchEnabled: 'yes' })
      .promptTemplatesInCommandSearchEnabled).toBe(false)
    expect(coerceSettings({ promptTemplatesInCommandSearchEnabled: true })
      .promptTemplatesInCommandSearchEnabled).toBe(true)
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
        'agent_management',
        12,
      ],
    }).defaultBuiltInMcpDomains).toEqual(['workflows', 'orchestration', 'agent_management'])
  })
})
