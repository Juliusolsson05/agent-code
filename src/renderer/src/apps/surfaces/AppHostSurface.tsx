import { useCallback, useMemo } from 'react'

import { useAppStore } from '@renderer/app-state/hooks'
import { createAppHostApi } from '@renderer/apps/api/createAppHostApi'
import { deriveAppDefinitions } from '@renderer/apps/host/derive'
import { Dialog, DialogContent, DialogTitle } from '@renderer/components/ui/dialog'
import { useGlobalToast } from '@renderer/ui/GlobalToast'

import type { AppDefinition } from '@renderer/apps/types'

/**
 * The single surface entry that hosts every extension view.
 *
 * WHY DialogContent rather than a hand-rolled shell: it mounts
 * `data-agent-code-interaction-owner="app"` for exactly the interval Radix traps
 * focus. Seven separate consumers query that marker synchronously — the keybind
 * router, the palette's native-menu guard, the global editor's Escape handler,
 * the composer Enter registry, type-to-focus, paste-to-focus, and the native
 * dictation hotkey. Without it, typing in an extension's input can leak Enter
 * and paste into a background agent composer, and a native menu click can mutate
 * the workspace underneath. `components/ui/README.md` records that exact failure
 * from the old hand-rolled composer guards. Hosting extensions inside the
 * primitive means they get all seven protections and cannot forget one.
 */
export function AppHostSurface() {
  const openAppId = useAppStore(state => state.openAppId)
  const installed = useAppStore(state => state.installedExtensions)

  // Derived per render from the store rather than a module-scope map. The
  // previous version built `APP_BY_ID` once at import time, which meant a newly
  // installed extension could not open until a reload.
  const definitions = useMemo(() => deriveAppDefinitions(installed), [installed])

  const definition = openAppId
    ? definitions.find(candidate => candidate.id === openAppId)
    : undefined

  // An unknown id degrades to closed, deliberately unlike
  // `providers/registry.renderer.ts`, which throws on an unknown pane kind — that
  // throw is correct there, because a pane with no renderer is a broken
  // workspace. It is wrong here: `openAppId` routinely holds a stale id after an
  // extension is uninstalled, and throwing inside a surface App.tsx mounts
  // unconditionally would take down the whole renderer.
  if (!definition) return null

  return <OpenExtensionView definition={definition} />
}

function OpenExtensionView({ definition }: { definition: AppDefinition }) {
  const closeApp = useAppStore(state => state.closeApp)
  const { showToast } = useGlobalToast()

  const api = useMemo(
    () =>
      createAppHostApi({
        // The view id is namespaced `<extensionId>.<view>`, and storage is keyed
        // by EXTENSION, not by view — two views of one extension must share
        // state, and `timer.main` must not get a different namespace from
        // `timer`.
        extensionId: definition.id.split('.')[0] ?? definition.id,
        showToast,
        closeSurface: () => closeApp(),
      }),
    [definition.id, showToast, closeApp],
  )

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (!open) closeApp()
    },
    [closeApp],
  )

  return (
    <Dialog open onOpenChange={onOpenChange}>
      {/* Content-width, not a fixed 560: the frame reports its natural size and the
          iframe takes a definite width/height, so a small extension stays snug while a
          large one (a game canvas) grows the modal up to the cap. Inline style beats
          the primitive's own `w-[…]` utility. */}
      <DialogContent
        showCloseButton
        className="overflow-hidden"
        style={{ width: 'auto', maxWidth: 'min(1160px, 94vw)' }}
      >
        {/* Radix requires an accessible title on every Dialog; visually hidden
            because an extension owns its own header treatment. Omitting it logs
            a console error and leaves the dialog unlabelled for screen readers. */}
        <DialogTitle className="sr-only">{definition.title}</DialogTitle>
        <definition.Component api={api} />
      </DialogContent>
    </Dialog>
  )
}
