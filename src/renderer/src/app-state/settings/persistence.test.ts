import { uniformBuiltInMcpDefaults } from '@mcp/shared/types'
import { describe, expect, it } from 'vitest'

import { coerceSettings } from '@renderer/app-state/settings/persistence'

describe('dictation audio input persistence', () => {
  it('preserves saved device identity through serialized settings without needing connected hardware', () => {
    const dictationAudioInput = { deviceId: 'saved-headset', label: 'USB Headset' }
    const saved = JSON.parse(JSON.stringify(coerceSettings({ dictationAudioInput })))
    expect(coerceSettings(saved).dictationAudioInput).toEqual(dictationAudioInput)
    expect(coerceSettings({ dictationAudioInput: { deviceId: 'default' } }).dictationAudioInput)
      .toEqual({ deviceId: 'default', label: '' })
  })

  it.each([undefined, null, 'headset', {}, { deviceId: 12 }, { deviceId: ' ' }])(
    'keeps automatic selection for absent or invalid settings: %j',
    dictationAudioInput => {
      expect(coerceSettings({ dictationAudioInput }).dictationAudioInput).toBeNull()
    },
  )
})

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

  it('defaults missing built-in MCP defaults to the shipped public set', () => {
    // Per provider since #1143; every provider starts from the same shipped set.
    expect(coerceSettings({}).defaultBuiltInMcpDomains)
      .toEqual(uniformBuiltInMcpDefaults(['tldr', 'goal', 'orchestration', 'agent_transcripts', 'workflows']))
  })

  it('respects an explicit empty MCP domain list', () => {
    // A pre-#1143 flat `[]` still means "nothing by default", now for every provider.
    expect(coerceSettings({ defaultBuiltInMcpDomains: [] }).defaultBuiltInMcpDomains).toEqual(uniformBuiltInMcpDefaults([]))
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
    }).defaultBuiltInMcpDomains).toEqual(uniformBuiltInMcpDefaults(['workflows', 'orchestration', 'agent_management']))
  })

  it('keeps a per-provider choice per provider (#1143)', () => {
    const defaults = coerceSettings({
      defaultBuiltInMcpDomains: { claude: ['tldr', 'ping'], codex: [], opencode: ['workflows'] },
    }).defaultBuiltInMcpDomains
    expect(defaults.claude).toEqual(['tldr'])
    expect(defaults.codex).toEqual([])
    expect(defaults.opencode).toEqual(['workflows'])
    // A provider missing from the saved map gets the shipped default.
    expect(defaults.grok).toEqual(['tldr', 'goal', 'orchestration', 'agent_transcripts', 'workflows'])
  })
})

describe('coerceSettings agentNamesEnabled', () => {
  it('defaults to off so no user starts allocating spoken names', () => {
    // WHY this assertion is worth a test of its own: a truthy default would
    // make every existing installation write agent-names.json on first launch
    // and burn pool entries for agents whose owner never asked for names.
    expect(coerceSettings({}).agentNamesEnabled).toBe(false)
  })

  it('accepts only a real boolean true', () => {
    expect(coerceSettings({ agentNamesEnabled: true }).agentNamesEnabled).toBe(true)
    expect(coerceSettings({ agentNamesEnabled: 'true' }).agentNamesEnabled).toBe(false)
    expect(coerceSettings({ agentNamesEnabled: 1 }).agentNamesEnabled).toBe(false)
    expect(coerceSettings({ agentNamesEnabled: null }).agentNamesEnabled).toBe(false)
  })
})

describe('coerceSettings default appearance (#973)', () => {
  it('opens a fresh install in Nord with the Frost accent', () => {
    const settings = coerceSettings({})
    expect(settings.mode).toBe('dark-nord')
    expect(settings.accent).toBe('frost')
  })

  // The one deliberate exception to "persisted values win": a blob on exactly
  // the OLD default pair never had its appearance touched, so it follows the
  // default to Nord. Anything else is a choice and stays.
  it('moves an untouched Dark + Lime install to Nord + Frost', () => {
    const settings = coerceSettings({ mode: 'dark', accent: 'lime' })
    expect(settings.mode).toBe('dark-nord')
    expect(settings.accent).toBe('frost')
  })

  it('leaves a deliberate Dark theme alone when the accent was changed', () => {
    const settings = coerceSettings({ mode: 'dark', accent: 'gold' })
    expect(settings.mode).toBe('dark')
    expect(settings.accent).toBe('gold')
  })

  it('keeps a non-default theme and only replaces the retired green accents', () => {
    expect(coerceSettings({ mode: 'dark-dim', accent: 'lime' })).toMatchObject({ mode: 'dark-dim', accent: 'frost' })
    expect(coerceSettings({ mode: 'light', accent: 'sage' })).toMatchObject({ mode: 'light', accent: 'frost' })
  })

  it('is idempotent across a second hydration', () => {
    const once = coerceSettings({ mode: 'dark', accent: 'lime' })
    expect(coerceSettings(JSON.parse(JSON.stringify(once)))).toMatchObject({ mode: 'dark-nord', accent: 'frost' })
    // …and a user who goes back to Dark afterwards is not migrated again.
    expect(coerceSettings({ ...once, mode: 'dark' })).toMatchObject({ mode: 'dark', accent: 'frost' })
  })
})

describe('coerceSettings retired keys', () => {
  // Found riding in a long-lived install's blob during the #973 audit: each
  // was a Settings field once, and `...parsed` copies whatever it finds, so
  // every one had survived every save since its field was deleted.
  it.each([
    'customRendering',
    'codeLineWrap',
    'showTerminalPreview',
    'showSystemEvents',
    'highContrast',
    'eventDrivenPasteSubmit',
    'dispatchProjectTerminal',
  ])('drops %s instead of carrying it forever', key => {
    expect(coerceSettings({ [key]: true })).not.toHaveProperty(key)
  })
})

// 'coerceSettings default workspace mode (#973)' lived here until the
// unified layout (#992 stage 8) deleted the setting: it chose between grid
// and Dispatch for a fresh install, and there is one layout now. A stale
// persisted `defaultWorkspaceMode` is dropped on read — which the generic
// "drops %s instead of carrying it forever" cases above now cover by listing
// the key among the dropped ones if it is ever reintroduced.

describe('coerceSettings public-release defaults (#973)', () => {
  // Each pair: an absent key resolves to the new default; an explicit value
  // — including the old default — is preserved. This is the promise that a
  // default flip never overrides a persisted choice.
  it.each([
    ['mouseModeEnabled', true, false],
    ['dangerousAgentsEnabled', true, false],
    ['usageHeaderEnabled', false, true],
    ['autoSendPromptSuggestion', false, true],
  ] as const)('%s defaults to %s but keeps an explicit %s', (key, fresh, explicit) => {
    expect(coerceSettings({})[key]).toBe(fresh)
    expect(coerceSettings({ [key]: explicit })[key]).toBe(explicit)
  })

  it('sorts the command picker by recency on a fresh install', () => {
    expect(coerceSettings({}).commandSortMode).toBe('recent')
    expect(coerceSettings({ commandSortMode: 'catalog' }).commandSortMode).toBe('catalog')
  })

  it('ships the owner dictation and palette bindings without turning dictation on', () => {
    const fresh = coerceSettings({})
    expect(fresh.dictationEnabled).toBe(false)
    expect(fresh.dictationShortcut).toBe('Fn')
    expect(fresh.dictationMouseButton).toBe('Middle')
    expect(fresh.paletteMouseChord).toBe('Middle+Right')
  })

  it('keeps explicitly cleared bindings cleared', () => {
    const cleared = coerceSettings({ dictationShortcut: 'off', dictationMouseButton: '', paletteMouseChord: '' })
    expect(cleared.dictationShortcut).toBe('')
    expect(cleared.dictationMouseButton).toBe('')
    expect(cleared.paletteMouseChord).toBe('')
  })
})

 it('preserves browser setup initialization and migrates already-enabled installs without re-seeding defaults', () => {
  expect(coerceSettings({}).browserPocketDefaultsInitialized).toBe(false)
  expect(coerceSettings({ browserPocketEnabled: true }).browserPocketDefaultsInitialized).toBe(true)
  const saved = coerceSettings({ browserPocketEnabled: false, browserPocketDefaultsInitialized: true })
  expect(coerceSettings(JSON.parse(JSON.stringify(saved))).browserPocketDefaultsInitialized).toBe(true)
 })
