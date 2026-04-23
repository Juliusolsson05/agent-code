import type { StateCreator } from 'zustand'

import { loadInitialSettings } from '@renderer/state/settings/persistence'
import { applyTheme } from '@renderer/state/settings/theme'
import { DEFAULT_SETTINGS } from '@renderer/state/settings/types'
import type { AppStore, SettingsSlice } from '@renderer/state/types'

const initialSettings = loadInitialSettings()
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
})
