import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { useAppStore } from '@renderer/app-state/hooks'
import {
  applyTheme,
  pickThemeSettings,
  themeSettingsForRemote,
  THEME_SETTING_KEYS,
} from '@renderer/app-state/settings/theme'

// Root effect extracted from App.tsx (#494). Theme is applied twice by
// design: once at settings-slice module load (pre-hydration default, no
// FOUC) and here whenever the theme's inputs change, which also mirrors the
// theme to main so the remote client's pages are served with matching colors.
// Desktop-only (window.api) — must never be imported from the shared
// feed subtree the phone bundle re-uses.
//
// WHY it selects only THEME_SETTING_KEYS (#784): selecting the whole settings
// object re-ran applyTheme and the IPC mirror on every unrelated preference
// or dispatch colour flag. useShallow re-renders (and so re-runs the effect)
// only when one of the theme inputs changes identity; savedThemes keeps its
// identity across unrelated patches because setSettings spreads the old
// settings. Hydration replaces the settings object with coerced values, and
// the effect then runs because the values differ from the pre-hydration
// defaults it last saw.
//
// The mirror carries only the theme keys, not the whole settings object: the
// phone merges it into its defaults and runs applyTheme, nothing else
// (remote-client WebSocketSessionFeed.applyRemoteThemeSettings), so the rest
// of the desktop's preferences never needed to cross the wire.
export function useThemeSync(): void {
  const themeInputs = useAppStore(useShallow(state => {
    const picked: Record<string, unknown> = {}
    for (const key of THEME_SETTING_KEYS) picked[key] = state.settings[key]
    return picked
  }))
  const extensions = useAppStore(state => state.installedExtensions)
  useEffect(() => {
    // The full settings object is read here, at effect time, because
    // applyTheme's signature takes Settings; only the picked inputs gate it.
    const settings = useAppStore.getState().settings
    applyTheme(settings, extensions)
    void window.api.remoteSetThemeSettings(pickThemeSettings(themeSettingsForRemote(settings, extensions)))
  }, [themeInputs, extensions])
}
