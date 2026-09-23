import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { DEFAULT_SETTINGS as defaultSettings } from '@renderer/app-state/settings/types'
import { browserPocketCommands } from './browserPocketCommands'

// Surviving mutations from review B: the switch defaulting on (M16), the
// toggle reachable with the feature off (M21), and ⌘⇧B silently dead in
// Spotlight (M15) had no test.

describe('Browser Pocket is off until the user turns it on', () => {
  it('defaults off, as does browser_evaluate', () => {
    expect(defaultSettings.browserPocketEnabled).toBe(false)
    expect(defaultSettings.browserPocketAllowEvaluate).toBe(false)
  })

  it('every pocket command is hidden while the feature is off', () => {
    const ctx = { flags: { browserPocketEnabled: false }, workspace: { state: { sessions: {} } } } as never
    for (const command of browserPocketCommands) {
      expect({ id: command.id, reason: command.unavailableReason?.(ctx)?.presentation }).toEqual({ id: command.id, reason: 'hide' })
    }
  })
})

it('Toggle Browser Pocket is allowed inside Spotlight (its fail-closed command allowlist)', () => {
  // Read rather than imported: the allowlist is module-private in useKeybinds.
  const source = readFileSync(join(__dirname, '../../../workspace/tile-tree/useKeybinds.ts'), 'utf8')
  const block = /SPOTLIGHT_FOCUS_MODE_COMMAND_IDS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(source)?.[1] ?? ''
  expect(block).toContain("'toggle-browser-pocket'")
})
