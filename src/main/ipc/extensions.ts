import { join } from 'path'

import { BrowserWindow, dialog, ipcMain } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'

import {
  extensionStorageDelete,
  extensionStorageGet,
  extensionStorageKeys,
  extensionStorageSet,
} from '@main/extensions/storage.js'
import { installExtension, installExtensionFromPath } from '@main/extensions/install.js'
import type { ConsentPrompt } from '@main/extensions/install.js'
import { listInstalledExtensions, removeExtension } from '@main/extensions/ledger.js'
import { grantedCapabilities, revokeGrant } from '@main/extensions/grants.js'
import { computeBundleHash } from '@main/extensions/bundleHash.js'
import { EXTENSIONS_DIR } from '@main/storage/paths.js'
import { isValidExtensionId } from '@shared/types/extensionId.js'
import type {
  ExtensionCapability,
  ExtensionInstallResult,
  ExtensionListEntry,
} from '@shared/types/extensions.js'

// The capability-consent dialog, shared by both install paths (GitHub + local
// folder). A blocking, OS-native dialog on purpose: granting an extension
// filesystem or session access is exactly the moment that must not be a quiet
// in-page toggle. Tier-0-only extensions never reach it (installers only call it
// when permissions is non-empty).
function consentPromptFor(evt: IpcMainInvokeEvent): ConsentPrompt {
  return async manifest => {
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
  }
}

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
        const record = await installExtension(repo, consentPromptFor(evt))
        return { ok: true, entry: { ...record, present: true } }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  // "Load unpacked" — install from a local folder chosen in a native picker, so an
  // author iterating on an unpublished extension never has to cut a GitHub release.
  // The picker runs in main (a directory chooser cannot be a renderer input), and
  // the same consent + validation pipeline as GitHub install applies.
  ipcMain.handle('extensions:install-path', async (evt): Promise<ExtensionInstallResult> => {
    const win = BrowserWindow.fromWebContents(evt.sender)
    const options = {
      properties: ['openDirectory' as const],
      title: 'Load extension from folder',
      message: "Choose the extension's built folder (containing agent-code.extension.json)",
    }
    const picked = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    const dir = picked.filePaths[0]
    if (picked.canceled || !dir) return { ok: false, error: 'No folder selected.' }
    try {
      const record = await installExtensionFromPath(dir, consentPromptFor(evt))
      return { ok: true, entry: { ...record, present: true } }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('extensions:remove', async (_evt, id: string): Promise<void> => {
    await removeExtension(id)
    // A reinstall must re-consent; a lingering grant would silently re-arm.
    await revokeGrant(id)
  })

  // Reads WHICH capabilities the user consented to for an extension. This is NOT
  // the Tier 1-3 escalation the module header forbids: it does not PERFORM any
  // capability (each capability still executes through its own per-feature IPC) —
  // it reports the grant so the frame broker (frameHost.perform) can GATE a
  // capability call before allowing it.
  //
  // ── THE HASH IS RECOMPUTED FROM DISK, NOT READ FROM THE LEDGER ──
  // This previously passed `entry.sha256`, the value the ledger recorded at
  // install. The grant's hash was written by the same finalizeInstall() call, so
  // the comparison inside grantedCapabilities compared two copies of one value
  // and could never fail. The documented invariant — different bytes, no grant —
  // did not exist, and editing a file under EXTENSIONS_DIR silently kept every
  // capability the user had approved for the original code.
  //
  // Hashing the bundle here is what makes the check real. It costs one read of
  // the bundle (capped at 32 MB by the installer, and typically a few hundred
  // KB) per frame creation — once when a view opens, not per capability call,
  // because frameHost caches the result for the frame's lifetime.
  //
  // Every failure path returns [] rather than throwing: an unreadable or missing
  // bundle must mean "no capabilities", never "unchanged". Fail closed.
  ipcMain.handle(
    'extensions:granted-capabilities',
    async (_evt, id: string): Promise<ExtensionCapability[]> => {
      if (!isValidExtensionId(id)) return []
      const installed = await listInstalledExtensions()
      const entry = installed.find(candidate => candidate.manifest.id === id)
      if (!entry) return []
      try {
        const actual = await computeBundleHash(join(EXTENSIONS_DIR, id))
        return [...(await grantedCapabilities(id, actual))]
      } catch {
        return []
      }
    },
  )
}
