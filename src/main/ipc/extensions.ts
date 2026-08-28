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
/**
 * What each capability actually discloses, in the user's terms.
 *
 * ── WHY THE RAW ENUM NAME IS NOT ENOUGH ──
 * The dialog used to render `  • sessions.observe` and nothing else. That gives a
 * user no way to know it discloses the ABSOLUTE WORKING DIRECTORY of every open
 * session — which for a working developer enumerates client names, private
 * repository names, and employer directory layout. A consent prompt that names a
 * permission without describing it is a prompt that can only be answered by
 * trusting the author, which is the decision it is supposed to inform.
 *
 * Keyed by the capability union, so a new capability does not compile until its
 * disclosure is written. That is deliberate: the description is part of shipping
 * the capability, not a follow-up.
 */
const CAPABILITY_DISCLOSURE: Record<ExtensionCapability, string> = {
  'workspace.observe': 'Which tabs are open, and how many sessions exist.',
  'sessions.observe':
    'Every open session: its title, its provider, and the full folder path it is running in.',
  'panes.observe': 'How your panes are arranged, and which session is in each one.',
}

function consentPromptFor(evt: IpcMainInvokeEvent, source: string): ConsentPrompt {
  return async manifest => {
    const win = BrowserWindow.fromWebContents(evt.sender)
    const permissions = manifest.permissions ?? []
    const detail = permissions.map(cap => `  • ${CAPABILITY_DISCLOSURE[cap]}`).join('\n')

    const options = {
      // 'question', not 'warning'. Every remaining capability is a read-only
      // metadata snapshot; the ones that ACTED were removed because nothing
      // implemented them. A warning triangle over three read permissions trains
      // click-through exactly as reliably as saying too little does, and the next
      // capability that genuinely deserves alarm would inherit a numb user.
      type: 'question' as const,
      buttons: ['Cancel', 'Grant & install'],
      // Both point at Cancel: Return, Escape and closing the window all decline.
      defaultId: 0,
      cancelId: 0,
      title: 'Extension permissions',
      // `source` is what the USER typed — the repo name or the folder they picked —
      // and AppsSettingsRow's own header calls it "the trust decision". It was the
      // one thing the dialog did not show. `manifest.name` is attacker-chosen and
      // only length-bounded, so it is presented as a claim about an identity
      // (`id`), never as the identity itself.
      message: `Install ${manifest.id} from ${source}?`,
      detail:
        `"${manifest.name}" wants to read:\n\n${detail}\n\n` +
        `It cannot change anything, and it has no network access. ` +
        `Install it only if you trust ${source}.`,
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
// NOT because identity is unavailable, but because the sender is never the
// extension. An extension frame is cross-origin with no preload and therefore no
// `ipcRenderer` at all — it cannot call this or any other handler. Every caller
// here is the trusted host renderer's main frame, brokering on the extension's
// behalf, so `event.senderFrame` would identify the BROKER, not the extension, and
// binding to it would achieve nothing.
//
// (An earlier version of this comment said the opposite: that every app shared one
// WebContents and that a future "Stage 2" giving each extension its own frame would
// make sender binding possible. That stage shipped — the frames exist — and the
// conclusion inverted rather than resolved. A maintainer acting on the old text
// would implement senderFrame binding, find it identifies the host, and either
// break every extension's storage or conclude that Tier 1-3 handlers are now safe
// here. They are not; see below.)
//
// The authority boundary is real, and it lives in two places that actually enforce
// it: `createAppHostApi` closes over one extensionId and is the sole call site of
// `window.api.extensionStorage*`, and `frameHost` refuses any message whose
// `event.source` is not that iframe's contentWindow and whose browser-stamped
// `event.origin` is not `agent-code-ext://<id>`.
//
// The prohibition stands unchanged: do NOT add workspace, session, transcript,
// git, filesystem or network capabilities to this module. Those must route through
// frameHost, where the origin check is — adding one here would be a real privilege
// escalation wearing a namespace's clothes.
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
        const record = await installExtension(repo, consentPromptFor(evt, repo.trim()))
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
      const record = await installExtensionFromPath(dir, consentPromptFor(evt, dir))
      return { ok: true, entry: { ...record, present: true } }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // Reinstall a LOCAL extension from the folder already recorded in its ledger row,
  // with no directory picker.
  //
  // WHY this is not a security regression: the path is not caller-supplied. It is
  // read from the ledger, where it was written by a native picker the user drove
  // themselves — so this re-runs a choice already made, exactly as the GitHub
  // Update button re-runs `owner/repo`. Making the renderer pass a path instead
  // WOULD be a regression: it would turn "reinstall what you chose" into "install
  // any directory on this machine, on the renderer's say-so".
  //
  // The full validation pipeline still runs: manifest parse, tree containment,
  // entry containment, and — for any manifest requesting permissions — a consent
  // prompt. That prompt is UNCONDITIONAL, not "only if the bytes changed":
  // finalizeInstall gates on `permissions.length`, never on a hash comparison, so
  // an author reloading an unchanged build is asked again. Deliberate, given the
  // alternative is comparing against a grant the reload is about to replace.
  ipcMain.handle('extensions:update-local', async (evt, id: string): Promise<ExtensionInstallResult> => {
    if (!isValidExtensionId(id)) return { ok: false, error: 'Unknown extension.' }
    const installed = await listInstalledExtensions()
    const entry = installed.find(candidate => candidate.manifest.id === id)
    if (!entry) return { ok: false, error: 'Extension is no longer installed.' }
    if (entry.origin !== 'local') {
      return { ok: false, error: 'This extension was installed from GitHub; use Update.' }
    }
    try {
      const record = await installExtensionFromPath(entry.repo, consentPromptFor(evt, entry.repo))
      return { ok: true, entry: { ...record, present: true } }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('extensions:remove', async (_evt, id: string): Promise<void> => {
    // The grant is revoked in a `finally`, not after a successful remove.
    //
    // Sequenced the other way, a removeExtension that threw partway — a locked
    // file, a permissions error, an interrupted write — left the bundle in an
    // unknown state AND the grant fully intact. Revoking is the safe direction in
    // every one of those outcomes: the worst case is that a still-installed
    // extension has to be re-consented, and the alternative worst case is a
    // half-removed extension retaining capabilities the user just tried to revoke.
    try {
      await removeExtension(id)
    } finally {
      await revokeGrant(id).catch(() => {})
    }
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
  // Hashing the bundle here is what makes the check real. It costs one read of the
  // bundle per frame creation — not one per capability call, because frameHost
  // resolves this once and every consumer (including viewBridge's observe
  // subscription) shares that one promise. The installer bounds the work on the
  // other side: 32 MB compressed, 256 MB extracted, 10,000 files.
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
