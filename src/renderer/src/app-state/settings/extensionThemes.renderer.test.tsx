import { afterEach, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useAppStore } from '@renderer/app-state/hooks'
import { createAppHostApi } from '@renderer/apps/api/createAppHostApi'
import { ThemePickerRow } from '@renderer/features/settings/ui/ThemePickerRow'
import { parseExtensionManifest } from '@main/extensions/manifest'
import type { ExtensionListEntry } from '@shared/types/extensions'
import { extensionThemeMode } from '@shared/types/extensionThemes'
import { coerceSettings } from './persistence'
import { applyTheme, resolveThemePayload, themeSettingsForRemote, THEME_CHANGED_EVENT } from './theme'
import { DEFAULT_SETTINGS } from './types'

const initial = useAppStore.getState()
afterEach(() => { useAppStore.setState(initial); applyTheme(initial.settings, initial.installedExtensions) })
const mode = extensionThemeMode('palette.night')
function entry(canvas = '#123456'): ExtensionListEntry {
  return { manifest: parseExtensionManifest(JSON.stringify({ id: 'palette', name: 'Palette Pack', description: 'A theme', version: '1', apiVersion: 2, entry: 'unused.js',
    contributes: { themes: [{ id: 'palette.night', title: 'Night', colors: { canvas, ink: '#abcdef' } }] } })),
    origin: 'local', repo: '/fixture', ref: 'local', sha256: 'hash', installedAt: 0, present: true }
}
const canvas = () => document.documentElement.style.getPropertyValue('--theme-canvas')

it('exposes applied palette colors through the actual frame API before stylesheets define them', async () => {
  applyTheme({ ...DEFAULT_SETTINGS, mode }, [entry()])
  const api = createAppHostApi({ extensionId: 'palette', closeSurface: () => {}, showToast: () => {} })
  expect((await api.theme.tokens())['--theme-canvas']).toBe('#123456')
})

it('restores selection after hydration and reconciles install/update/remove/reinstall through the real store', () => {
  useAppStore.getState().setInstalledExtensions([])
  useAppStore.getState().setSettings(coerceSettings(JSON.parse(JSON.stringify({ ...DEFAULT_SETTINGS, mode }))))
  expect(useAppStore.getState().settings.mode).toBe(mode)
  expect(document.documentElement.dataset.mode).toBe('dark')
  const events: string[] = []
  const changed = () => events.push(canvas())
  window.addEventListener(THEME_CHANGED_EVENT, changed)
  try {
    useAppStore.getState().setInstalledExtensions([entry()])
    expect(canvas()).toBe('#123456')
    useAppStore.getState().setSettings({ contrast: true })
    expect(canvas()).toBe('#123456')
    useAppStore.getState().setInstalledExtensions([entry('#654321')])
    expect(canvas()).toBe('#654321')
    useAppStore.getState().setInstalledExtensions([{ ...entry(), present: false }])
    expect(canvas()).toBe('')
    expect(document.documentElement.dataset.mode).toBe('dark')
    expect(document.documentElement.dataset.contrast).toBe('high')
    useAppStore.getState().setInstalledExtensions([])
    expect(useAppStore.getState().settings.mode).toBe(mode)
    useAppStore.getState().setInstalledExtensions([entry()])
    expect(canvas()).toBe('#123456')
    expect(events).toContain('#654321')
    expect(events).toContain('')
    expect(useAppStore.getState().settings.savedThemes).toEqual(DEFAULT_SETTINGS.savedThemes)
  } finally { window.removeEventListener(THEME_CHANGED_EVENT, changed) }
})

it('keeps built-in and user-owned palettes independent of installed contributions', () => {
  const saved = { id: 'theme:mine', name: 'Night', json: '{"canvas":"#abcdef"}', createdAt: 0, updatedAt: 0 }
  const settings = { ...DEFAULT_SETTINGS, savedThemes: [saved], mode: saved.id }
  expect(resolveThemePayload(settings, [entry()])?.canvas).toBe('#abcdef')
  expect(resolveThemePayload({ ...settings, mode: 'dark' }, [entry()])).toBeNull()
  expect(coerceSettings({ ...settings, mode: 'extension-theme:../escape' }).mode).toBe('dark')
})

it('sends resolved appearance to the phone without changing the persisted desktop selection', () => {
  const settings = { ...DEFAULT_SETTINGS, mode }
  const remote = themeSettingsForRemote(settings, [entry()])
  applyTheme(remote)
  expect(canvas()).toBe('#123456')
  expect(settings.mode).toBe(mode)
  expect(remote.savedThemes).toEqual(settings.savedThemes)
  applyTheme(themeSettingsForRemote(settings, []))
  expect(document.documentElement.dataset.mode).toBe('dark')
  expect(canvas()).toBe('')
})

it('offers the extension theme in the real picker and explains a missing selected bundle', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  function Picker() {
    const settings = useAppStore(state => state.settings)
    return <ThemePickerRow settings={settings} onSelect={mode => useAppStore.getState().setSettings({ mode })} onCreate={() => {}} onEdit={() => {}} onDelete={() => {}} />
  }
  try {
    await act(async () => { useAppStore.getState().setInstalledExtensions([entry()]); root.render(<Picker />) })
    const button = [...container.querySelectorAll('button')].find(button => button.textContent?.includes('Palette Pack'))!
    expect(button).toBeDefined()
    await act(async () => button.click())
    expect(canvas()).toBe('#123456')
    expect(button.getAttribute('aria-pressed')).toBe('true')
    expect(container.textContent).not.toContain('Delete')
    await act(async () => useAppStore.getState().setInstalledExtensions([]))
    expect(container.querySelector('[role="status"]')?.textContent).toContain('unavailable')
    expect(useAppStore.getState().settings.mode).toBe(mode)
  } finally { await act(async () => root.unmount()); container.remove() }
})
