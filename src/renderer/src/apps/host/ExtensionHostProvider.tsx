import { createContext, useContext, useEffect, useMemo, useRef } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { createAppHostApi } from '@renderer/apps/api/createAppHostApi'
import { ExtensionHost } from '@renderer/apps/host/ExtensionHost'
import { useGlobalToast } from '@renderer/ui/GlobalToast'

const ExtensionHostContext = createContext<ExtensionHost | null>(null)

export function useExtensionHost(): ExtensionHost | null {
  return useContext(ExtensionHostContext)
}

/**
 * Owns the single ExtensionHost and drives the install → load → activate cycle.
 *
 * WHY a provider rather than a module singleton: the host needs `showToast`,
 * which is React context, and it needs to push failures into the store. Both are
 * app-lifetime concerns, and a module singleton would have to reach for them
 * through globals.
 */
export function ExtensionHostProvider({ children }: { children: React.ReactNode }) {
  const { showToast } = useGlobalToast()
  const setInstalledExtensions = useAppStore(state => state.setInstalledExtensions)
  const setExtensionFailures = useAppStore(state => state.setExtensionFailures)
  const closeApp = useAppStore(state => state.closeApp)

  // Refs so the host is constructed exactly once and never re-created by a
  // re-render. Re-creating it would orphan every activated extension: their
  // modules stay in the module cache but their registrations would be gone, and
  // a second activate() would run activate() twice on the same module instance.
  const closeAppRef = useRef(closeApp)
  closeAppRef.current = closeApp
  const showToastRef = useRef(showToast)
  showToastRef.current = showToast

  const host = useMemo(
    () =>
      new ExtensionHost(
        extensionId =>
          createAppHostApi({
            extensionId,
            // Through refs so the API object handed to a long-lived extension
            // never captures a stale callback from the render that created it.
            showToast: message => showToastRef.current(message),
            closeSurface: () => closeAppRef.current(),
          }),
        failures => setExtensionFailures(failures),
      ),
    [setExtensionFailures],
  )

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      let installed: Awaited<ReturnType<typeof window.api.extensionsList>>
      try {
        installed = await window.api.extensionsList()
      } catch {
        // A failed list is not an empty list. Leaving the store untouched keeps
        // whatever was previously loaded rather than making every extension
        // vanish because one IPC call failed.
        return
      }
      if (cancelled) return
      setInstalledExtensions(installed)

      // NOTE (Group A): host-realm onStartupFinished/'*' eager activation was
      // REMOVED here on purpose. It imported and ran the extension in the renderer's
      // OWN realm — unsandboxed, with access to window.api the frame model exists to
      // deny — and, worse, produced a SECOND instance separate from the one the view
      // frame runs, so a background engine (the timer) and its visible view drove
      // different state. Activation now happens only inside the extension's frame.
      //
      // Consequence until the background-frame follow-up (A4): a startup/'*'
      // extension activates lazily on its first view/command open rather than at
      // launch. For the timer this means its wall-clock deadline is still restored
      // from storage on open (so the TIME is never lost), but reminders do not fire
      // while every view is closed. That is correct-but-later, never split-brain —
      // and A4 restores true background activation via a persistent headless frame.
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [setInstalledExtensions])

  useEffect(() => {
    return () => {
      // Best-effort on teardown. In practice the renderer is going away anyway,
      // but an extension holding an interval or an AudioContext deserves its
      // deactivate() called rather than being killed mid-flight.
      void host.deactivateAll()
    }
  }, [host])

  return <ExtensionHostContext.Provider value={host}>{children}</ExtensionHostContext.Provider>
}
