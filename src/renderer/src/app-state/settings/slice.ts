import type { StateCreator } from 'zustand'

import { applyTheme } from '@renderer/app-state/settings/theme'
import { DEFAULT_SETTINGS } from '@renderer/app-state/settings/types'
import type { AppStore, SettingsSlice } from '@renderer/app-state/types'

// WHY this is seeded with defaults instead of reading a separate
// localStorage `:settings` key:
// Zustand persist is the real settings source of truth (`store.ts` persists
// the settings slice under `APP_STORE_STORAGE_KEY` and coerces it during
// merge/migrate). The old direct reader path read a pre-persist key
// that nothing writes anymore, which made boot look like it had two settings
// authorities. Module load now applies the deliberate default theme; App.tsx's
// settings effect re-applies the persisted/coerced settings once hydration
// lands. The old direct pre-persist reader is intentionally gone.
const initialSettings = DEFAULT_SETTINGS
applyTheme(initialSettings)

export const createSettingsSlice: StateCreator<
  AppStore,
  [['zustand/devtools', never], ['zustand/subscribeWithSelector', never]],
  [],
  SettingsSlice
> = set => ({
  settings: initialSettings,
  setSettings: patch =>
    set(state => {
      const next = { ...state.settings, ...patch }
      applyTheme(next)
      return { settings: next }
    }, false, 'settings/setSettings'),
  resetSettings: () =>
    set(() => {
      applyTheme(DEFAULT_SETTINGS)
      return { settings: DEFAULT_SETTINGS }
    }, false, 'settings/resetSettings'),
  toggleCustomRendering: () =>
    set(state => {
      const next = {
        ...state.settings,
        customRendering: !state.settings.customRendering,
      }
      applyTheme(next)
      return { settings: next }
    }, false, 'settings/toggleCustomRendering'),
  toggleStatusMode: () =>
    set(state => {
      const next = {
        ...state.settings,
        showStatusMode: !state.settings.showStatusMode,
      }
      applyTheme(next)
      return { settings: next }
    }, false, 'settings/toggleStatusMode'),
  toggleWorktreeBadges: () =>
    set(state => {
      const next = {
        ...state.settings,
        showWorktreeBadges: !state.settings.showWorktreeBadges,
      }
      applyTheme(next)
      return { settings: next }
    }, false, 'settings/toggleWorktreeBadges'),
})
