import { useEffect } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'

/**
 * Loads the install ledger into the store, once, at startup.
 *
 * ── WHY THIS IS NO LONGER A PROVIDER ──
 * It was `ExtensionHostProvider`, and it constructed an `ExtensionHost` that
 * imported and activated extension modules in the RENDERER'S OWN REALM — where
 * `window.api` exposes every IPC handler, including `extensions:install` and
 * `extensions:remove`. Once activation moved into the sandboxed frame, that host
 * had no callers left: `activate()`, `executeCommand()` and the whole
 * registration store were dead, and `index.html` had already dropped
 * `agent-code-ext:` from `script-src`, so the import it existed to perform could
 * not have run anyway.
 *
 * Six files still called `useExtensionHost()` and threaded the object into
 * `derive*`, which ignored it. Deleting the host removed the context, and what
 * was left is this: one effect that fills `installedExtensions`. A component
 * whose only job is a startup effect does not need to wrap the tree, but it
 * stays a component (rather than a hook called from App) so the ordering
 * constraint below is expressed by where it sits in main.tsx rather than by a
 * comment somewhere else.
 *
 * ── WHAT REPLACED THE HOST'S FAILURE TRACKING ──
 * `ExtensionHost` collected failures from its own try/catch around import and
 * activate. Those now happen inside the frame, so the frame reports them over
 * postMessage and `viewBridge` publishes them to the same store slice. The
 * Settings row is unchanged; only the producer moved to the far side of the
 * sandbox, which is where the code actually runs.
 */
export function InstalledExtensionsLoader({ children }: { children: React.ReactNode }) {
  const setInstalledExtensions = useAppStore(state => state.setInstalledExtensions)

  useEffect(() => {
    let cancelled = false

    void (async () => {
      let installed: Awaited<ReturnType<typeof window.api.extensionsList>>
      try {
        installed = await window.api.extensionsList()
      } catch {
        // A failed list is not an empty list. Leaving the store untouched keeps
        // `installedExtensionsLoaded` false, which is what stops ExtensionViewLeaf
        // from telling the user an installed extension is missing.
        return
      }
      if (cancelled) return
      setInstalledExtensions(installed)
    })()

    return () => {
      cancelled = true
    }
  }, [setInstalledExtensions])

  // ── NO EAGER ACTIVATION HAPPENS HERE, DELIBERATELY ──
  // `onStartupFinished` and `'*'` activation events are declared in manifests,
  // validated at install, and currently fire NOWHERE. That is a real gap, and it
  // is named as one in docs/extensions/authoring.md rather than papered over: the
  // honest fix is a hidden background frame per extension, because reintroducing
  // host-realm activation is what the sandbox exists to prevent. Until then an
  // extension activates on its first view open or command invocation, which means
  // background work does not run while every view is closed.
  return <>{children}</>
}
