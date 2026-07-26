import { describe, expect, it } from 'vitest'

import { builtInCommandCatalog } from '@renderer/features/command-palette/catalog'
import { getSettingsRegistry, settingMetadata } from '@renderer/features/settings/lib/settingsRegistry'

// ---------------------------------------------------------------------------
// Phase 8: naming and Settings information architecture.
// ---------------------------------------------------------------------------

const titleOf = (id: string) => {
  const command = builtInCommandCatalog.find(c => c.id === id)
  if (!command) throw new Error(`no command ${id}`)
  return typeof command.title === 'function' ? command.id : command.title
}
const keywordsOf = (id: string) =>
  builtInCommandCatalog.find(c => c.id === id)?.keywords ?? []

describe('command naming corrections', () => {
  it.each([
    ['toggle-tail', 'Auto-follow Focused Agent'],
    ['toggle-tail-all', 'Auto-follow All Visible Agents'],
    ['close-pane', 'Close Focused Session'],
    ['bury-pane', 'Bury Session'],
    ['revive-pane', 'Revive Buried Session…'],
    ['kill-buried-pane', 'Kill Buried Session…'],
    ['global-dispatch', 'Dispatch Scope'],
    ['toggle-session-recording', 'Session Recording'],
    ['set-agent-view-mode', 'Agent View for This Session…'],
    ['dispatch.color-flag.set', 'Set Color Flag…'],
  ])('renames %s to %s', (id, title) => {
    expect(titleOf(id)).toBe(title)
  })

  it('keeps ids stable across every rename', () => {
    // Titles are presentation; IDS are the contract that user visibility
    // overrides, keybinding overrides and native-menu lookups are keyed on.
    // Renaming an id would silently discard a user's settings.
    const ids = new Set(builtInCommandCatalog.map(c => c.id))
    for (const id of [
      'toggle-tail', 'toggle-tail-all', 'close-pane', 'bury-pane',
      'revive-pane', 'kill-buried-pane', 'global-dispatch',
      'toggle-session-recording', 'set-agent-view-mode', 'dispatch.color-flag.set',
    ]) {
      expect(ids.has(id)).toBe(true)
    }
  })

  it('retains the old vocabulary as searchable keywords', () => {
    // Someone with "Tail" in muscle memory must still find the renamed
    // command. A rename that breaks search is a rename that breaks the feature.
    expect(keywordsOf('toggle-tail')).toContain('tail')
    expect(keywordsOf('toggle-tail-all')).toContain('tail')
    expect(keywordsOf('close-pane')).toContain('pane')
    expect(keywordsOf('global-dispatch')).toContain('global dispatch')
  })

  it('uses a typographic ellipsis, never three periods', () => {
    for (const command of builtInCommandCatalog) {
      if (typeof command.title !== 'string') continue
      expect(command.title).not.toMatch(/\.\.\./)
    }
  })

  it('stops using Pane for things that outlive their pane', () => {
    // Bury/Revive/Kill act on SESSIONS. The live object persists without a
    // pane, so "Pane" named the wrong noun.
    for (const id of ['bury-pane', 'revive-pane', 'kill-buried-pane', 'close-pane']) {
      expect(titleOf(id)).not.toMatch(/\bPane\b/)
    }
  })
})

describe('settings metadata', () => {
  it('defaults to app / immediate / settings', () => {
    // Defaulting keeps the EXCEPTIONS visible: a row carrying explicit
    // metadata is one where the obvious reading would have been wrong.
    const plain = getSettingsRegistry().find(row => row.id === 'auto-send-prompt-suggestion')
    expect(plain && settingMetadata(plain)).toEqual({
      scope: 'app',
      apply: 'immediate',
      storage: 'settings',
    })
  })

  it('marks Dangerous Agents as reloading live agents', () => {
    // The audit's sharpest copy defect: the row claimed existing agents were
    // unaffected while enabling it reloads the whole fleet.
    const row = getSettingsRegistry().find(r => r.id === 'dangerous-agents')
    expect(row && settingMetadata(row)).toMatchObject({
      apply: 'reload-live-sessions',
      status: 'dangerous',
    })
  })

  it('marks values that do not live in renderer Settings', () => {
    // This is what makes "Reset Settings" answerable: the API key is in the
    // keychain and the CLI update policy is in main's setup.json, so neither
    // is cleared by resetting Settings.
    const key = getSettingsRegistry().find(r => r.id === 'dictation-api-key')
    expect(key && settingMetadata(key).storage).toBe('keychain')
    const cli = getSettingsRegistry().find(r => r.id === 'cli-update-behavior')
    expect(cli && settingMetadata(cli).storage).toBe('setup')
  })

  it('marks the fresh-install-only scope', () => {
    const row = getSettingsRegistry().find(r => r.id === 'default-workspace-mode')
    expect(row && settingMetadata(row).scope).toBe('fresh-install')
  })
})
