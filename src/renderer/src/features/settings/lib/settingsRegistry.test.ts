import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS } from '@renderer/app-state/settings/types'
import {
  getSettingsRegistry,
  type SettingActionContext,
  type SettingDefinition,
} from '@renderer/features/settings/lib/settingsRegistry'

type ToggleSetting = Extract<SettingDefinition, { control: { type: 'toggle' } }>

function defaultMcpToggle(id: string): ToggleSetting {
  const setting = getSettingsRegistry().find(candidate => candidate.id === id)
  if (!setting || setting.control.type !== 'toggle') {
    throw new Error(`Missing MCP toggle setting: ${id}`)
  }
  return setting as ToggleSetting
}

describe('built-in MCP default settings', () => {
  it('exposes all configurable product domains without a persistent ping setting', () => {
    const ids = getSettingsRegistry().map(setting => setting.id)
    expect(ids).toEqual(expect.arrayContaining([
      'default-orchestration-mcp',
      'default-ai-workspace-mcp',
      'default-agent-transcripts-mcp',
      'default-workflow-mcp',
    ]))
    expect(ids).not.toContain('default-ping-mcp')
  })

  it('adds and removes one domain without disturbing sibling defaults', async () => {
    const setting = defaultMcpToggle('default-workflow-mcp')
    const onChange = vi.fn()
    const enabledSettings = {
      ...DEFAULT_SETTINGS,
      defaultBuiltInMcpDomains: ['orchestration' as const],
    }
    const context = {
      settings: enabledSettings,
      onChange,
    } as unknown as SettingActionContext

    await setting.control.onToggle(context, true)
    expect(onChange).toHaveBeenLastCalledWith({
      defaultBuiltInMcpDomains: ['orchestration', 'workflows'],
    })

    await setting.control.onToggle({
      ...context,
      settings: {
        ...enabledSettings,
        defaultBuiltInMcpDomains: ['orchestration', 'workflows'],
      },
    }, false)
    expect(onChange).toHaveBeenLastCalledWith({
      defaultBuiltInMcpDomains: ['orchestration'],
    })
  })

  it('documents Workflow MCP as Codex-only because Claude is native', () => {
    const setting = defaultMcpToggle('default-workflow-mcp')
    expect(setting.description).toContain('Codex only')
    expect(setting.description).toContain('Claude uses its native workflow feature')
  })
})
