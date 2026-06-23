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
})
