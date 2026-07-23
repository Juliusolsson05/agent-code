import type { StateCreator } from 'zustand'

import { applyTheme } from '@renderer/app-state/settings/theme'
import { DEFAULT_SETTINGS, USAGE_HEADER_LEVELS } from '@renderer/app-state/settings/types'
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
  // Set or clear a per-agent Dispatch color flag. `null` deletes the key so the
  // map only ever holds flagged sessions (no accumulation of explicit "none"s).
  // No applyTheme — flags are per-session row chrome, not part of the theme.
  setDispatchColorFlag: (sessionId, colorId) =>
    set(state => {
      const next = { ...state.settings.dispatchColorFlags }
      if (colorId === null) delete next[sessionId]
      else next[sessionId] = colorId
      return { settings: { ...state.settings, dispatchColorFlags: next } }
    }, false, 'settings/setDispatchColorFlag'),
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
  toggleUsageHeader: () =>
    set(state => {
      const next = {
        ...state.settings,
        usageHeaderEnabled: !state.settings.usageHeaderEnabled,
      }
      applyTheme(next)
      return { settings: next }
    }, false, 'settings/toggleUsageHeader'),
  cycleUsageHeaderLevel: () =>
    set(state => {
      const index = USAGE_HEADER_LEVELS.indexOf(state.settings.usageHeaderLevel)
      const next = {
        ...state.settings,
        // Circular walk of the canonical order (types.ts owns it).
        usageHeaderLevel:
          USAGE_HEADER_LEVELS[(index + 1) % USAGE_HEADER_LEVELS.length],
        // Cycling while hidden also enables the header: a user reaching
        // for "more usage detail" obviously wants the widget visible —
        // silently rotating an invisible setting would look like the
        // command does nothing.
        usageHeaderEnabled: true,
      }
      applyTheme(next)
      return { settings: next }
    }, false, 'settings/cycleUsageHeaderLevel'),
})
