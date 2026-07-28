import { BrowserWindow, dialog, ipcMain } from 'electron'

import {
  extensionStorageDelete,
  extensionStorageGet,
  extensionStorageKeys,
  extensionStorageSet,
} from '@main/extensions/storage.js'
import { installExtension } from '@main/extensions/install.js'
import { listInstalledExtensions, removeExtension } from '@main/extensions/ledger.js'
import { grantedCapabilities, revokeGrant } from '@main/extensions/grants.js'
import type {
  ExtensionCapability,
  ExtensionInstallResult,
  ExtensionListEntry,
} from '@shared/types/extensions.js'

// IPC for extension-app state.
//
// WHY appId is a caller-supplied parameter rather than derived from the sender:
// in Stage 1 every app is compiled into the one renderer and shares a single
// WebContents, so `event.sender` cannot distinguish the timer from any other app.
// That makes this a NAMESPACE, not an authority boundary — any renderer code can
// name any app's namespace today, exactly as it can already call the other ~130
// unvalidated handlers in this directory.
//
// The invariant that matters is therefore about what may be added here, not about
// who is calling: storage is the only capability whose worst case (an app reading
// another app's saved preferences, in a single-user desktop app where all app code
// is compiled from this repo) is acceptable without sender binding. Do NOT add
// workspace, session, transcript, git, filesystem, or network capabilities to this
// module. Those are Tier 1-3 in the API design and they need the sender-derived
// identity that only Stage 2 — where each app gets its own frame and preload — can
// provide. Adding one here would be a real privilege escalation wearing a
// namespace's clothes.
export function registerExtensionsIpc(): void {
  ipcMain.handle('extensions:storage-get', async (_evt, appId: string, key: string) =>
    extensionStorageGet(appId, key),
  )

  ipcMain.handle(
    'extensions:storage-set',
    async (_evt, appId: string, key: string, value: unknown) =>
      extensionStorageSet(appId, key, value),
  )

  ipcMain.handle('extensions:storage-delete', async (_evt, appId: string, key: string) =>
    extensionStorageDelete(appId, key),
  )

  ipcMain.handle('extensions:storage-keys', async (_evt, appId: string) =>
    extensionStorageKeys(appId),
  )

  ipcMain.handle('extensions:list', async (): Promise<ExtensionListEntry[]> =>
    listInstalledExtensions(),
  )

  // WHY install returns a result object instead of rejecting: every failure here is
  // something the user can act on — wrong repo name, private repo, missing
  // manifest, unsupported API version, archive too large. An IPC rejection reaches
  // the renderer as `Error invoking remote method 'extensions:install': …` with the
  // real message buried in a prefix, and the error class is lost across the bridge.
  // Returning `{ ok: false, error }` keeps the actionable sentence intact and makes
  // the Settings UI's job a render, not a parse.
  ipcMain.handle(
    'extensions:install',
    async (evt, repo: string): Promise<ExtensionInstallResult> => {
      try {
        // The consent prompt for capability-requesting extensions. A blocking,
        // OS-native dialog on purpose: granting an extension filesystem or session
        // access is exactly the moment that must not be a quiet in-page toggle the
        // user clicks through. Tier-0-only extensions never reach this (installExtension
        // only calls it when permissions is non-empty).
        const record = await installExtension(repo, async manifest => {
          const win = BrowserWindow.fromWebContents(evt.sender)
          const detail = (manifest.permissions ?? []).map(cap => `  • ${cap}`).join('\n')
          const options = {
            type: 'warning' as const,
            buttons: ['Cancel', 'Grant & install'],
            defaultId: 0,
            cancelId: 0,
            title: 'Extension permissions',
            message: `${manifest.name} requests capabilities beyond the default:`,
            detail: `${detail}\n\nThese let the extension act outside its own sandbox. Only grant them if you trust ${manifest.id}.`,
          }
          const result = win
            ? await dialog.showMessageBox(win, options)
            : await dialog.showMessageBox(options)
          return result.response === 1
        })
        return { ok: true, entry: { ...record, present: true } }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.handle('extensions:remove', async (_evt, id: string): Promise<void> => {
    await removeExtension(id)
    // A reinstall must re-consent; a lingering grant would silently re-arm.
    await revokeGrant(id)
  })

  // Reads WHICH capabilities the user consented to for an extension. This is NOT
  // the Tier 1-3 escalation the module header forbids: it does not PERFORM any
  // capability (each capability still executes through its own per-feature IPC) —
  // it reports the grant so the frame broker (frameHost.perform) can GATE a
  // capability call before allowing it. Keyed on the installed sha256 so a grant
  // recorded for old bytes never authorizes new ones; grantedCapabilities enforces
  // that match and returns empty on mismatch or unknown id.
  ipcMain.handle(
    'extensions:granted-capabilities',
    async (_evt, id: string): Promise<ExtensionCapability[]> => {
      const installed = await listInstalledExtensions()
      const entry = installed.find(candidate => candidate.manifest.id === id)
      if (!entry) return []
      return [...(await grantedCapabilities(id, entry.sha256))]
    },
  )
}
