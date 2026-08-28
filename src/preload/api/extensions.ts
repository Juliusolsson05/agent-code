import { ipcRenderer } from 'electron'

import type {
  ExtensionCapability,
  ExtensionInstallResult,
  ExtensionListEntry,
} from '@shared/types/extensions.js'

// Extension-app storage and management bridge.
//
// ── WHO IS ALLOWED TO CALL WHAT, AND WHY IT IS TWO GROUPS ──
// An earlier version of this header claimed these methods had a single call site,
// `apps/api/useAppHostApi.ts`, and that a second one would mean "the ABI has been
// bypassed". That module does not exist, and five files call these methods
// directly — so the comment asserted a security-shaped invariant that was simply
// false, which is worse than no comment at all.
//
// The real rule has two halves:
//
//   The STORAGE methods are extension-facing, and `createAppHostApi` is their only
//   legitimate call site. It closes over one extension id, so an extension can
//   never name another's namespace. A second call site for THOSE would be a real
//   bypass. (ExtensionSettingRow also calls them, deliberately: a contributed
//   settings row reads and writes the extension's own storage on its behalf, with
//   the id coming from the validated manifest.)
//
//   The MANAGEMENT methods — list, install, install-path, update-local, remove,
//   granted-capabilities — are host-facing by design. The Settings UI and the frame
//   broker call them directly and must. An extension must never reach them, and it
//   cannot: its frame is cross-origin with no preload, so it has no `window.api`
//   and no ipcRenderer at all.
export const extensionsApi = {
  extensionStorageGet: (appId: string, key: string): Promise<unknown> =>
    ipcRenderer.invoke('extensions:storage-get', appId, key),

  extensionStorageSet: (appId: string, key: string, value: unknown): Promise<void> =>
    ipcRenderer.invoke('extensions:storage-set', appId, key, value),

  extensionStorageDelete: (appId: string, key: string): Promise<void> =>
    ipcRenderer.invoke('extensions:storage-delete', appId, key),

  extensionStorageKeys: (appId: string): Promise<string[]> =>
    ipcRenderer.invoke('extensions:storage-keys', appId),

  // Install management. These are HOST methods, not part of AgentCodeApiV1 — an
  // extension must never be able to install or remove another extension. They are
  // called only by the Settings UI.
  extensionsList: (): Promise<ExtensionListEntry[]> => ipcRenderer.invoke('extensions:list'),

  extensionsInstall: (repo: string): Promise<ExtensionInstallResult> =>
    ipcRenderer.invoke('extensions:install', repo),

  // "Load unpacked" from a local folder (main opens the native directory picker).
  extensionsInstallPath: (): Promise<ExtensionInstallResult> =>
    ipcRenderer.invoke('extensions:install-path'),

  // Reinstall a locally-loaded extension from the folder recorded at install time.
  // Takes only the id — main reads the path from its own ledger, so the renderer
  // never names a directory.
  extensionsUpdateLocal: (id: string): Promise<ExtensionInstallResult> =>
    ipcRenderer.invoke('extensions:update-local', id),

  extensionsRemove: (id: string): Promise<void> => ipcRenderer.invoke('extensions:remove', id),

  // Reads the set of capabilities a user granted an extension, for the frame broker
  // to gate Tier 1-3 calls. A HOST method, not part of AgentCodeApiV1 — an extension
  // must never read (or change) its own or another's grants; only the broker calls it.
  extensionGrantedCapabilities: (id: string): Promise<ExtensionCapability[]> =>
    ipcRenderer.invoke('extensions:granted-capabilities', id),
}
