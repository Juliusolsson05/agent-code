import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useAppStore } from '@renderer/app-state/hooks'
import { THEME_CHANGED_EVENT } from '@renderer/app-state/settings/theme'
import { ACCENTS } from '@renderer/app-state/settings/types'
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
