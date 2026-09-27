import type { StateCreator } from 'zustand'

import { applyTheme, patchTouchesTheme } from '@renderer/app-state/settings/theme'
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
      // Synchronous on purpose, so a theme change is visible in the same
      // frame as the click; useThemeSync re-applies after commit. Only a
      // patch that touches a theme input pays for it (#784).
      if (patchTouchesTheme(patch)) applyTheme(next, state.installedExtensions)
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
  // The toggles below change row/header chrome only, never a theme input, so
  // they no longer re-apply the theme (#784). They used to, which rewrote the
  // palette and fired THEME_CHANGED_EVENT for every xterm and Monaco on a
  // usage-header toggle.
  toggleStatusMode: () =>
    set(state => {
      const next = {
        ...state.settings,
        showStatusMode: !state.settings.showStatusMode,
      }
      return { settings: next }
    }, false, 'settings/toggleStatusMode'),
  toggleWorktreeBadges: () =>
    set(state => {
      const next = {
        ...state.settings,
        showWorktreeBadges: !state.settings.showWorktreeBadges,
      }
      return { settings: next }
    }, false, 'settings/toggleWorktreeBadges'),
  toggleUsageHeader: () =>
    set(state => {
      const next = {
        ...state.settings,
        usageHeaderEnabled: !state.settings.usageHeaderEnabled,
      }
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
      return { settings: next }
    }, false, 'settings/cycleUsageHeaderLevel'),
})
