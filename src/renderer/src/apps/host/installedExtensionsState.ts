import { useAppStore } from '@renderer/app-state/hooks'
import { extensionRevision } from '@shared/types/extensions'
import type { InstalledExtension } from '@shared/types/extensions'

// All list writers share one ordering guard. Settings used to own a second copy
// of the catalog, so a slow initial IPC could resurrect an extension after the
// remove notification or hide a newer update. This is renderer-local sequencing;
// main's publication event is the authority for installed generations.
let requestVersion = 0

export async function refreshInstalledExtensions(): Promise<boolean> {
  const version = ++requestVersion
  useAppStore.getState().setInstalledExtensionsError(null)
  try {
    const entries = await window.api.extensionsList()
    if (version !== requestVersion) return false
    useAppStore.getState().setInstalledExtensions(entries)
    return true
  } catch (error) {
    if (version === requestVersion) {
      useAppStore.getState().setInstalledExtensionsError(error instanceof Error ? error.message : String(error))
    }
    return false
  }
}

export function acceptExtensionPublication(rows: InstalledExtension[]): void {
  ++requestVersion
  const state = useAppStore.getState()
  // Apply removals and changed identities immediately, before a fallible refresh.
  // That unmounts stale frames in every window even if the follow-up list fails.
  // Presence is a filesystem annotation: carry it for unchanged generations and
  // let listInstalledExtensions refresh it; a newly published bundle exists.
  state.setInstalledExtensions(rows.map(row => {
    const previous = state.installedExtensions.find(entry => entry.manifest.id === row.manifest.id)
    return {
      ...row,
      present: previous && extensionRevision(previous) === extensionRevision(row) ? previous.present : true,
    }
  }))
}

export function forgetRemovedExtension(removed: InstalledExtension): void {
  const current = useAppStore.getState().installedExtensions
  // A later reinstall from another window must win over this earlier remove's
  // delayed IPC reply. Only discard the generation the caller actually removed.
  if (!current.some(row => row.manifest.id === removed.manifest.id && extensionRevision(row) === extensionRevision(removed))) return
  ++requestVersion
  useAppStore.getState().setInstalledExtensions(current.filter(row =>
    row.manifest.id !== removed.manifest.id || extensionRevision(row) !== extensionRevision(removed)))
}
