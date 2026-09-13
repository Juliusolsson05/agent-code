import { useEffect } from 'react'

import { acceptExtensionPublication, refreshInstalledExtensions } from './installedExtensionsState'

/**
 * Subscribe before loading the first catalog so an install in another window
 * cannot fall between the initial read and listener registration. The catalog
 * contains declarations only; extension code still executes across its sandbox
 * boundary. Keeping one store also makes Settings and live panes agree.
 */
export function InstalledExtensionsLoader({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const unsubscribe = window.api.onExtensionsChanged(rows => {
      acceptExtensionPublication(rows)
      void refreshInstalledExtensions()
    })
    void refreshInstalledExtensions()
    return unsubscribe
  }, [])
  return <>{children}</>
}
