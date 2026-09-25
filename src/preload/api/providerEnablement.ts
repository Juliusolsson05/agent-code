import { ipcRenderer } from 'electron'

import { subscribe } from '@preload/api/ipc.js'
import type { Unsub } from '@preload/api/types.js'
import type {
  OpencodeUsageSource,
  ProviderEnablementSnapshot,
} from '@shared/types/providerEnablement.js'
import type { AgentProviderKind } from '@shared/types/providerKind.js'

// Preload bridge for provider enablement (#1102). Its own module for the
// same reason as cliUpdates: a mutable main-owned setting plus a state
// broadcast is a distinct surface, and the channel prefix mirrors it.
export const providerEnablementApi = {
  providerEnablementGet: (): Promise<ProviderEnablementSnapshot> =>
    ipcRenderer.invoke('provider-enablement:get'),
  providerEnablementSet: (
    kind: AgentProviderKind,
    enabled: boolean,
  ): Promise<ProviderEnablementSnapshot> =>
    ipcRenderer.invoke('provider-enablement:set', kind, enabled),
  providerEnablementReset: (kind: AgentProviderKind): Promise<ProviderEnablementSnapshot> =>
    ipcRenderer.invoke('provider-enablement:reset', kind),
  providerEnablementSetOpencodeUsageSource: (
    value: OpencodeUsageSource,
  ): Promise<ProviderEnablementSnapshot> =>
    ipcRenderer.invoke('provider-enablement:set-opencode-usage-source', value),
  onProviderEnablementChanged: (cb: (snapshot: ProviderEnablementSnapshot) => void): Unsub =>
    subscribe('provider-enablement:changed', cb),
}
