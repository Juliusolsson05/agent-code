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
import { listInstalledExtensions, listQuarantinedExtensions, onExtensionPublication, removeExtension, removeQuarantinedExtension } from '@main/extensions/ledger.js'
import { installedExtensionCapabilities } from '@main/extensions/grants.js'
import { isValidExtensionId } from '@shared/types/extensionId.js'
import type {
  ExtensionCapability,
  ExtensionInstallResult,
  ExtensionListEntry,
  QuarantinedExtensionEntry,
} from '@shared/types/extensions.js'
import { withVisibleControls } from '@shared/text/visibleControls.js'

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
  'fs.read':
    'The contents of text files it names inside projects belonging to active sessions.',
  'fs.write':
    'Create or replace text files it names inside projects belonging to active sessions.',
  'notifications.show':
    'Show short app-wide status notifications while it runs in the background.',
  // The one disclosure that is about TRUST rather than data: a service is a
  // bundled program the host launches as a real child process with this user's
  // privileges. It can read and write what this account can, open network
  // connections, and run for as long as Agent Code is open. The grant gates the
  // host's lifecycle/proxy conveniences — it is not a sandbox. If that sounds
  // alarming, it is meant to: this is the VS Code extension-host decision,
  // made once, per extension, here.
  'service.run':
    'Run bundled native programs as child processes with this user’s privileges — only when you use the extension’s start control. Native code is not sandboxed.',
  'service.transport':
    'Exchange requests with its own running service on this machine (the host proxies them; the extension cannot reach anything else on the network).',
  'net.listen':
    'Make one of its running services reachable from this machine’s local network. The host owns that listener and closes it when the service stops. Use a trusted network only.',
  'net.connect':
    'Open web requests to addresses you or the extension enter on this local network (private addresses only in this release; the request goes through the host, not the sandbox).',
}

function consentPromptFor(evt: IpcMainInvokeEvent, source: string): ConsentPrompt {
  return async manifest => {
    const win = BrowserWindow.fromWebContents(evt.sender)
    const permissions = manifest.permissions ?? []
    // A manifest that asks for NOTHING still gets a dialog (#1049 re-review).
    // Tier 0 used to install in silence, so nothing ever showed the user which
    // folder or repository they were about to run code from — and the
    // extension row that does show it appears only afterwards. The wording
    // drops the capability paragraph, because there is nothing to grant; the
    // decision is the source.
    if (permissions.length === 0) {
      const plain = {
        type: 'question' as const,
        buttons: ['Cancel', 'Install'],
        defaultId: 0,
        cancelId: 0,
        title: 'Install extension',
        message: `Install ${withVisibleControls(manifest.id)} from ${withVisibleControls(source)}?`,
        detail:
          `"${withVisibleControls(manifest.name)}" requests no capabilities: it cannot read or change `
          + `project files and has no network access.\n\n`
          + `Install it only if you trust ${withVisibleControls(source)}.`,
      }
      const plainResult = win
        ? await dialog.showMessageBox(win, plain)
        : await dialog.showMessageBox(plain)
      return plainResult.response === 1
    }
    const detail = permissions.map(cap => `  • ${CAPABILITY_DISCLOSURE[cap]}`).join('\n')
    const canWrite = permissions.includes('fs.write')

    const options = {
      // Read-only requests stay a question. A real project mutation uses warning
      // chrome so the first acting capability does not inherit the visual weight
      // of metadata observation and train users to treat both grants as equal.
      type: canWrite ? 'warning' as const : 'question' as const,
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
      // Every interpolated field here is attacker-chosen (#1049 review).
      message: `Install ${withVisibleControls(manifest.id)} from ${withVisibleControls(source)}?`,
      detail:
        `"${withVisibleControls(manifest.name)}" wants these capabilities:\n\n${withVisibleControls(detail)}\n\n` +
        `${canWrite ? 'It can change project files.' : 'It cannot change project files.'} ` +
        `It has no network access. ` +
        // The same value, twice, and the second one was raw: a source string
        // with a bidi override could therefore spoof the sentence that carries
        // the whole trust decision (#1049 re-review).
        `Install it only if you trust ${withVisibleControls(source)}.`,
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
  onExtensionPublication(rows => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
        try { window.webContents.send('extensions:changed', rows) } catch (error) {
          // Closing one window must not prevent revocation reaching the others.
          console.warn('[extensions] window publication failed:', error)
        }
      }
    }
  })
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

  // Rows this build set aside (#959). Separate from `extensions:list` because
  // they are NOT installed extensions: nothing here is loaded, activated or
  // granted anything, and giving them the same shape would invite a caller to
  // treat one as runnable. Settings shows them so the user can see why an
  // extension is missing and remove it, which is the whole recovery path.
  ipcMain.handle('extensions:list-quarantined', async (): Promise<QuarantinedExtensionEntry[]> =>
    listQuarantinedExtensions(),
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
    // `useGithubCliAuth` defaults to true via `!== false` so older renderers
    // (and the remote companion) that call with one argument keep the
    // credential upgrade without knowing it exists.
    async (evt, repo: string, useGithubCliAuth?: boolean): Promise<ExtensionInstallResult> => {
      try {
        // firstInstall: `owner/repo` typed (or pasted) just now. A pasted one
        // can carry invisible characters, and this dialog is where they show.
        const record = await installExtension(repo, consentPromptFor(evt, repo.trim()), {
          githubCliAuth: useGithubCliAuth !== false,
        }, true)
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
      // firstInstall: the user picked this folder just now, and nothing has
      // shown them its name in a form that reveals invisible characters.
      const record = await installExtensionFromPath(dir, consentPromptFor(evt, dir), true)
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

  // Re-install a GITHUB extension from the `owner/repo` already recorded in its
  // ledger row — the counterpart of update-local, and for the same reason.
  //
  // WHY this exists instead of the Update button re-calling `extensions:install`
  // with `entry.repo` (#1049 round 9): that handler hardcodes `firstInstall=true`,
  // because everything reaching it IS a first install — a string the user just
  // typed or pasted into the box, which is exactly when an invisible-character
  // repo name has to be shown before code runs. Routing Update through it made
  // every Tier-0 update prompt again, which is the noise the firstInstall split
  // was introduced to avoid: the source was chosen once, approved once, and is
  // now read back from OUR ledger, not from the renderer.
  //
  // The renderer names an id, never a repo, so this cannot be turned into
  // "install any repository on the renderer's say-so". Everything else is
  // unchanged: normalizeRepo, download, tree/entry containment, and an
  // unconditional consent prompt for any manifest that requests capabilities.
  ipcMain.handle(
    'extensions:update-github',
    async (evt, id: string, useGithubCliAuth?: boolean): Promise<ExtensionInstallResult> => {
      if (!isValidExtensionId(id)) return { ok: false, error: 'Unknown extension.' }
      const installed = await listInstalledExtensions()
      const entry = installed.find(candidate => candidate.manifest.id === id)
      if (!entry) return { ok: false, error: 'Extension is no longer installed.' }
      if (entry.origin !== 'github') {
        return { ok: false, error: 'This extension was loaded from a folder; use Reload.' }
      }
      try {
        const record = await installExtension(entry.repo, consentPromptFor(evt, entry.repo), {
          githubCliAuth: useGithubCliAuth !== false,
        })
        return { ok: true, entry: { ...record, present: true } }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  ipcMain.handle('extensions:remove', async (_evt, id: string): Promise<void> => {
    await removeExtension(id)
  })

  // Clearing a SET-ASIDE row is a different operation from uninstalling an
  // extension, not a flag on it (#959 review): a ledger can hold both under one
  // id, and one handler doing whichever it found meant clearing the set-aside
  // row uninstalled the working extension and deleted its bundle.
  ipcMain.handle('extensions:remove-quarantined', async (_evt, id: string): Promise<void> => {
    await removeQuarantinedExtension(id)
  })

  // Consent belongs to the committed installation, and is checked against a
  // fresh full-bundle digest. The helper holds the publication lock across both
  // reads, so an update cannot mix one generation's bytes with another's grant.
  ipcMain.handle(
    'extensions:granted-capabilities',
    async (_evt, id: string, revision: string): Promise<ExtensionCapability[]> => {
      if (!isValidExtensionId(id) || typeof revision !== 'string') return []
      return installedExtensionCapabilities(id, revision)
    },
  )
}
