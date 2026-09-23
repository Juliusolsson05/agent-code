import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@renderer/app-state/hooks'

import { DEFAULT_SETTINGS as defaultSettings } from '@renderer/app-state/settings/types'
import { browserPocketCommands } from './browserPocketCommands'

const focused = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('@renderer/workspace/hook/selectors/commandTargetSessionId', () => ({ commandTargetSessionId: () => focused.id }))
afterEach(() => { focused.id = null; vi.restoreAllMocks() })

describe('Browser Pocket is off until the user turns it on', () => {
  it('defaults off, as does browser_evaluate', () => {
    expect(defaultSettings.browserPocketEnabled).toBe(false)
    expect(defaultSettings.browserPocketAllowEvaluate).toBe(false)
  })

  it('the entry point stays available for setup while other actions are hidden', () => {
    const ctx = { flags: { browserPocketEnabled: false }, workspace: { state: { sessions: {} } } } as never
    for (const command of browserPocketCommands) {
      expect({ id: command.id, reason: command.unavailableReason?.(ctx)?.presentation }).toEqual({ id: command.id, reason: command.id === 'toggle-browser-pocket' ? 'disable' : 'hide' })
    }
  })
})

it('Toggle Browser Pocket is allowed inside Spotlight (its fail-closed command allowlist)', () => {
  // Read rather than imported: the allowlist is module-private in useKeybinds.
  const source = readFileSync(join(__dirname, '../../../workspace/tile-tree/useKeybinds.ts'), 'utf8')
  const block = /SPOTLIGHT_FOCUS_MODE_COMMAND_IDS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(source)?.[1] ?? ''
  expect(block).toContain("'toggle-browser-pocket'")
})

it.each([undefined, { pocketId: 'saved', view: 'open', profile: 'lane' }])('first use opens the focused agent even with a saved pocket: %s', browserPocket => {
  focused.id = 's1'
  const setSettings = vi.fn()
  vi.spyOn(useAppStore, 'getState').mockReturnValue({ settings: defaultSettings, setSettings } as never)
  let state = { sessions: { s1: { kind: 'codex', browserPocket } } }
  const ctx = { flags: { browserPocketEnabled: false }, workspace: {
    state, updateBrowserPocket: (update: (current: typeof state) => typeof state) => { state = update(state) },
  } } as never
  const command = browserPocketCommands.find(c => c.id === 'toggle-browser-pocket')!
  expect(command.unavailableReason?.(ctx)).toBeNull()
  command.run(ctx)
  expect(setSettings).toHaveBeenCalledWith(expect.objectContaining({ browserPocketEnabled: true, browserPocketDefaultsInitialized: true, defaultBuiltInMcpDomains: expect.objectContaining({ codex: expect.arrayContaining(['browser']) }) }))
  expect(state.sessions.s1).toMatchObject({ browserPocket: { view: 'open' } })
})
