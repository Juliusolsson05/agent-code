import { ipcRenderer } from 'electron'

import { subscribe } from '@preload/api/ipc.js'
import type { Unsub } from '@preload/api/types.js'
import type {
  UserMcpImportResult,
  UserMcpMutationResult,
  UserMcpProvider,
  UserMcpSaveInput,
  UserMcpSnapshot,
  UserMcpUnavailableEvent,
} from '@shared/userMcp/types.js'

// Preload bridge for user MCP servers (#1143). Its own module for the same
// reason as providerEnablement: a main-owned document plus a state broadcast
// is a distinct surface, and the channel prefix mirrors it. Secret VALUES only
// ever travel renderer → main (set); nothing here can read one back.
export const userMcpApi = {
  userMcpGet: (): Promise<UserMcpSnapshot> => ipcRenderer.invoke('user-mcp:get'),
  userMcpSave: (input: UserMcpSaveInput): Promise<UserMcpMutationResult> =>
    ipcRenderer.invoke('user-mcp:save', input),
  userMcpDelete: (id: string): Promise<UserMcpMutationResult> => ipcRenderer.invoke('user-mcp:delete', id),
  userMcpSetEnabled: (id: string, enabled: boolean): Promise<UserMcpMutationResult> =>
    ipcRenderer.invoke('user-mcp:set-enabled', id, enabled),
  userMcpSetProvider: (id: string, provider: UserMcpProvider, enabled: boolean): Promise<UserMcpMutationResult> =>
    ipcRenderer.invoke('user-mcp:set-provider', id, provider, enabled),
  userMcpSetSecret: (id: string, inputId: string, value: string): Promise<UserMcpMutationResult> =>
    ipcRenderer.invoke('user-mcp:set-secret', id, inputId, value),
  userMcpImport: (text: string, fallbackName?: string): Promise<UserMcpImportResult> =>
    ipcRenderer.invoke('user-mcp:import', text, fallbackName),
  userMcpCopyNative: (provider: UserMcpProvider, name: string): Promise<UserMcpMutationResult> =>
    ipcRenderer.invoke('user-mcp:copy-native', provider, name),
  onUserMcpChanged: (cb: (snapshot: UserMcpSnapshot) => void): Unsub => subscribe('user-mcp:changed', cb),
  onUserMcpUnavailable: (cb: (event: UserMcpUnavailableEvent) => void): Unsub =>
    subscribe('user-mcp:unavailable', cb),
  /** An agent with the MCP Servers capability changed the configuration. */
  onUserMcpAgentChange: (cb: (event: { message: string }) => void): Unsub =>
    subscribe('user-mcp:agent-change', cb),
}
