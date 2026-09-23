import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS } from '@renderer/app-state/settings/types'
import { CONFIGURABLE_BUILT_IN_MCP_DOMAINS } from '@mcp/shared/types'
import { BUILT_IN_MCP_SERVERS } from '@renderer/features/mcp/lib/builtInServers'
import {
  getSettingsRegistry,
  matchesSettingQuery,
  settingMetadata,
  type SettingActionContext,
  type SettingDefinition,
} from '@renderer/features/settings/lib/settingsRegistry'

describe('MCP settings (#1143)', () => {
  it('replaces the per-domain default toggles with one MCP grid in the MCP category', () => {
    const registry = getSettingsRegistry()
    expect(registry.filter(setting => /^default-.*-mcp$/.test(setting.id))).toEqual([])
    const grid = registry.find(setting => setting.id === 'mcp-servers')
    expect(grid?.category).toBe('mcp')
    expect(grid?.control.type).toBe('mcp-servers')
    expect(registry.find(setting => setting.id === 'external-control')?.category).toBe('mcp')
  })

  it('still finds the grid by the name of every built-in capability it replaced', () => {
    // Users who learned "search Settings for orchestration" must still land on
    // the place that default now lives.
    const grid = getSettingsRegistry().find(setting => setting.id === 'mcp-servers')!
    for (const word of ['tldr', 'goal', 'orchestration', 'ai workspace', 'transcripts', 'agent management', 'workflow', 'beeper']) {
      expect(matchesSettingQuery(grid, word), word).toBe(true)
    }
  })

  it('lists every configurable built-in domain exactly once in the grid', () => {
    const domains = BUILT_IN_MCP_SERVERS.map(server => server.domain)
    expect([...domains].sort()).toEqual([...CONFIGURABLE_BUILT_IN_MCP_DOMAINS].sort())
  })
})

describe('prompt templates in command search setting', () => {
  it('is an off-by-default toggle that patches only its search preference', async () => {
    const setting = getSettingsRegistry().find(
      candidate => candidate.id === 'prompt-templates-in-command-search',
    )
    if (!setting || setting.control.type !== 'toggle') {
      throw new Error('Missing prompt template command-search toggle')
    }

    expect(setting.control.getValue(DEFAULT_SETTINGS)).toBe(false)
    expect(setting.description).toContain('after you type')
    expect(setting.description).toContain('default menu stays command-only')

    const onChange = vi.fn()
    await setting.control.onToggle({
      settings: DEFAULT_SETTINGS,
      onChange,
    } as unknown as SettingActionContext, true)
    expect(onChange).toHaveBeenCalledWith({
      promptTemplatesInCommandSearchEnabled: true,
    })
  })
})

describe('agent names setting', () => {
  it('is an immediate app-scoped workspace toggle that reads and writes agentNamesEnabled', async () => {
    const setting = getSettingsRegistry().find(candidate => candidate.id === 'agent-names')
    if (!setting || setting.control.type !== 'toggle') throw new Error('Missing agent-names toggle')
    expect(setting.category).toBe('workspace')
    // The resolved metadata is what operators read through settings.reference,
    // and "takes effect at once" is a real claim: enabling must name the agents
    // already on screen, not only the next session. Asserting the RESOLVED
    // value (not `setting.metadata`) keeps the row free to stay on the default.
    expect(settingMetadata(setting)).toEqual({ scope: 'app', apply: 'immediate', storage: 'settings' })
    expect(setting.control.getValue(DEFAULT_SETTINGS)).toBe(false)
    expect(setting.control.getValue({ ...DEFAULT_SETTINGS, agentNamesEnabled: true })).toBe(true)

    const onChange = vi.fn()
    const context = { settings: DEFAULT_SETTINGS, onChange } as unknown as SettingActionContext
    await setting.control.onToggle(context, true)
    expect(onChange).toHaveBeenLastCalledWith({ agentNamesEnabled: true })
    await setting.control.onToggle(context, false)
    expect(onChange).toHaveBeenLastCalledWith({ agentNamesEnabled: false })
  })
})

 it('seeds browser tools once and preserves a later provider opt-out through feature toggles', async () => {
  const setting = getSettingsRegistry().find(s => s.id === 'browser-pocket')!
  if (setting.control.type !== 'toggle') throw new Error('Expected toggle')
  let settings = { ...DEFAULT_SETTINGS }
  const onChange = (patch: Partial<typeof settings>) => { settings = { ...settings, ...patch } }
  const ctx = () => ({ settings, onChange } as unknown as SettingActionContext)
  await setting.control.onToggle(ctx(), true)
  expect(settings.browserPocketDefaultsInitialized).toBe(true)
  expect(settings.defaultBuiltInMcpDomains.codex).toContain('browser')
  settings = { ...settings, defaultBuiltInMcpDomains: { ...settings.defaultBuiltInMcpDomains, codex: [] } }
  await setting.control.onToggle(ctx(), false)
  await setting.control.onToggle(ctx(), true)
  expect(settings.defaultBuiltInMcpDomains.codex).toEqual([])
 })
