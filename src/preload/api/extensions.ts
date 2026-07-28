import { ipcRenderer } from 'electron'

import type {
  ExtensionCapability,
  ExtensionInstallResult,
  ExtensionListEntry,
} from '@shared/types/extensions.js'

// Extension-app storage bridge.
//
// These are the only `extension*`-prefixed methods on the flat api object, and the
// prefix is doing real work: it is what lets `apps/api/useAppHostApi.ts` be the sole
// call site. App code never touches `window.api` — it receives AgentCodeApiV1, which
// closes over its own app id. If a second call site for these methods ever appears
// outside useAppHostApi, the ABI has been bypassed and an app has become
// non-portable, which is the one failure Stage 1 exists to prevent.
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

  extensionsRemove: (id: string): Promise<void> => ipcRenderer.invoke('extensions:remove', id),

  // Reads the set of capabilities a user granted an extension, for the frame broker
  // to gate Tier 1-3 calls. A HOST method, not part of AgentCodeApiV1 — an extension
  // must never read (or change) its own or another's grants; only the broker calls it.
  extensionGrantedCapabilities: (id: string): Promise<ExtensionCapability[]> =>
    ipcRenderer.invoke('extensions:granted-capabilities', id),
}
