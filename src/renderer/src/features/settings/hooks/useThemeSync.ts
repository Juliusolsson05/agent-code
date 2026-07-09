import { useEffect } from 'react'
import { useAppStore } from '@renderer/app-state/hooks'
import { applyTheme } from '@renderer/app-state/settings/theme'

// Root effect extracted from App.tsx (#494). Theme is applied twice by
// design: once at settings-slice module load (pre-hydration default, no
// FOUC) and here on every settings change, which also mirrors the theme
// to main so the remote client's pages are served with matching colors.
// Desktop-only (window.api) — must never be imported from the shared
// feed subtree the phone bundle re-uses.
export function useThemeSync(): void {
  const settings = useAppStore(state => state.settings)
  useEffect(() => {
    applyTheme(settings)
    void window.api.remoteSetThemeSettings(settings)
  }, [settings])
}
