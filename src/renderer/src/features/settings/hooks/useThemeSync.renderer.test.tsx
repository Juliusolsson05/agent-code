import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/hooks'
import { parseExtensionManifest } from '@main/extensions/manifest'
import type { ExtensionListEntry } from '@shared/types/extensions'
import { extensionThemeMode } from '@shared/types/extensionThemes'
import { THEME_CHANGED_EVENT, THEME_SETTING_KEYS } from '@renderer/app-state/settings/theme'
import type { Settings } from '@renderer/app-state/settings/types'
import { ACCENTS, CORNER_STYLES, FONT_FAMILIES, isDarkThemeMode, THEME_MODES } from '@renderer/app-state/settings/types'
import { useThemeSync } from './useThemeSync'

// #784: theme application (≈90 inline CSS properties + THEME_CHANGED_EVENT,
// which every xterm and Monaco re-reads) and the phone mirror IPC must run
// only when a theme input changes. These count both per settings change;
// before this change every unrelated toggle below cost 2 applications and 1
// full-settings IPC.
const initial = useAppStore.getState()
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
const mirror = vi.fn(async (_settings: unknown) => {})
let applications = 0
const onThemeChanged = () => { applications += 1 }

beforeEach(() => {
  Object.defineProperty(window, 'api', { configurable: true, value: { remoteSetThemeSettings: mirror } })
  window.addEventListener(THEME_CHANGED_EVENT, onThemeChanged)
})
afterEach(() => {
  window.removeEventListener(THEME_CHANGED_EVENT, onThemeChanged)
  act(() => { useAppStore.setState(initial) })
  if (originalApi) Object.defineProperty(window, 'api', originalApi)
  else Reflect.deleteProperty(window, 'api')
})

function mount() {
  renderHook(() => useThemeSync())
  applications = 0
  mirror.mockClear()
}

it.each([
  ['usage header', () => useAppStore.getState().setSettings({ usageHeaderEnabled: !useAppStore.getState().settings.usageHeaderEnabled })],
  ['status-mode toggle', () => useAppStore.getState().toggleStatusMode()],
  ['worktree-badge toggle', () => useAppStore.getState().toggleWorktreeBadges()],
  ['usage-level cycle', () => useAppStore.getState().cycleUsageHeaderLevel()],
  ['dispatch colour flag', () => useAppStore.getState().setDispatchColorFlag('s1', 'red' as never)],
])('an unrelated change (%s) neither applies the theme nor mirrors it', (_label, change) => {
  mount()
  act(() => { change() })
  expect(applications).toBe(0)
  expect(mirror).not.toHaveBeenCalled()
})

it('a theme change applies at once and mirrors only the theme keys', () => {
  mount()
  const current = useAppStore.getState().settings.accent
  const other = ACCENTS.find(accent => accent.id !== current)!.id
  act(() => { useAppStore.getState().setSettings({ accent: other }) })
  expect(applications).toBeGreaterThan(0)
  expect(mirror).toHaveBeenCalledTimes(1)
  const payload = mirror.mock.calls[0]![0] as Record<string, unknown>
  expect(payload.accent).toBe(other)
  expect(payload).not.toHaveProperty('dispatchColorFlags')
  expect(payload).not.toHaveProperty('usageHeaderEnabled')
})

it('a saved-theme edit (a new savedThemes array) still re-applies and mirrors', () => {
  mount()
  act(() => { useAppStore.getState().setSettings({ savedThemes: [...useAppStore.getState().settings.savedThemes] }) })
  expect(applications).toBeGreaterThan(0)
  expect(mirror).toHaveBeenCalledTimes(1)
})

it('an installed-extension change still re-applies and mirrors', () => {
  mount()
  act(() => { useAppStore.setState({ installedExtensions: [] }) })
  expect(mirror).toHaveBeenCalledTimes(1)
})

// #1400 review a: every key in THEME_SETTING_KEYS must still apply and mirror.
// Dropping one from the list used to leave every test green while that edit
// (mode, font, custom JSON...) silently stopped updating the theme.
function changedValue(key: (typeof THEME_SETTING_KEYS)[number], settings: Settings): unknown {
  switch (key) {
    case 'mode': return THEME_MODES.find(mode => mode.id !== settings.mode)!.id
    case 'contrast': return !settings.contrast
    case 'accent': return ACCENTS.find(accent => accent.id !== settings.accent)!.id
    case 'fontFamily': return FONT_FAMILIES.find(font => font.id !== settings.fontFamily)!.id
    case 'cornerStyle': return CORNER_STYLES.find(style => style.id !== settings.cornerStyle)!.id
    case 'savedThemes': return [...settings.savedThemes]
    case 'customAppearanceJson': return `${settings.customAppearanceJson} `
  }
}

it.each(THEME_SETTING_KEYS.map(key => [key]))('a change to %s applies and mirrors the new value', key => {
  mount()
  const value = changedValue(key, useAppStore.getState().settings)
  act(() => { useAppStore.getState().setSettings({ [key]: value } as Partial<Settings>) })
  expect(applications).toBeGreaterThan(0)
  expect(mirror).toHaveBeenCalledTimes(1)
  expect((mirror.mock.calls[0]![0] as Record<string, unknown>)[key]).toEqual(value)
})

it('covers exactly the settings the theme reads', () => {
  expect([...THEME_SETTING_KEYS].sort()).toEqual(['accent', 'contrast', 'cornerStyle', 'customAppearanceJson', 'fontFamily', 'mode', 'savedThemes'])
})

// The phone has no extension catalog: an extension theme must reach it as the
// resolved palette (mode 'custom' plus colours), not the extension mode.
function extensionEntry(canvas: string): ExtensionListEntry {
  return { manifest: parseExtensionManifest(JSON.stringify({ id: 'palette', name: 'Palette Pack', description: 'A theme', version: '1', apiVersion: 2, entry: 'unused.js',
    contributes: { themes: [{ id: 'palette.night', title: 'Night', colors: { canvas, ink: '#abcdef' } }] } })),
    origin: 'local', repo: '/fixture', ref: 'local', sha256: 'hash', installedAt: 0, present: true }
}

it('mirrors an active extension theme as its resolved palette', () => {
  mount()
  act(() => { useAppStore.setState({ installedExtensions: [extensionEntry('#123456')] }) })
  mirror.mockClear()
  act(() => { useAppStore.getState().setSettings({ mode: extensionThemeMode('palette.night') }) })
  expect(mirror).toHaveBeenCalledTimes(1)
  const payload = mirror.mock.calls[0]![0] as Record<string, unknown>
  expect(payload.mode).toBe('custom')
  expect(JSON.parse(String(payload.customAppearanceJson)).canvas).toBe('#123456')
})

const accentVar = () => document.documentElement.style.getPropertyValue('--theme-accent')
const accentColour = (id: string) => {
  const accent = ACCENTS.find(entry => entry.id === id)!
  return isDarkThemeMode(useAppStore.getState().settings.mode) ? accent.dark : accent.light
}
const otherAccent = () => ACCENTS.find(accent => accent.id !== useAppStore.getState().settings.accent)!.id

// Hydration replaces `settings` without going through setSettings, so only the
// hook can apply the persisted theme to the desktop.
it('applies a hydrated theme that bypassed setSettings', () => {
  mount()
  const other = otherAccent()
  act(() => { useAppStore.setState({ settings: { ...useAppStore.getState().settings, accent: other as Settings['accent'] } }) })
  expect(accentVar()).toBe(accentColour(other))
})

// A picker click must paint in the same frame, before any React effect runs.
it('paints a theme change synchronously, before effects flush', () => {
  mount()
  const other = otherAccent()
  useAppStore.getState().setSettings({ accent: other as Settings['accent'] })
  expect(accentVar()).toBe(accentColour(other))
  act(() => {})
})
