import { ipcRenderer } from 'electron'

import { subscribe } from '@preload/api/ipc.js'
import type { Unsub } from '@preload/api/types.js'
import type {
  AiWorkspaceAttachFileParams,
  AiWorkspaceCreateParams,
  AiWorkspaceDetachFileParams,
  AiWorkspaceFileEntry,
  AiWorkspaceOpenRequest,
  AiWorkspaceReadFileResult,
  AiWorkspaceRecord,
  AiWorkspaceSummary,
  AiWorkspaceWriteFileResult,
} from '@mcp/shared/aiWorkspaceTypes.js'

export const aiWorkspaceApi = {
  aiWorkspaceCreate: (params: AiWorkspaceCreateParams): Promise<AiWorkspaceRecord> =>
    ipcRenderer.invoke('ai-workspace:create', params),
  aiWorkspaceList: (): Promise<AiWorkspaceSummary[]> =>
    ipcRenderer.invoke('ai-workspace:list'),
  aiWorkspaceGet: (workspaceId: string): Promise<AiWorkspaceRecord | null> =>
    ipcRenderer.invoke('ai-workspace:get', workspaceId),
  aiWorkspaceAttachFile: (
    params: AiWorkspaceAttachFileParams,
  ): Promise<AiWorkspaceFileEntry> =>
    ipcRenderer.invoke('ai-workspace:attach-file', params),
  aiWorkspaceDetachFile: (
    params: AiWorkspaceDetachFileParams,
  ): Promise<{ removed: boolean; remaining: number }> =>
    ipcRenderer.invoke('ai-workspace:detach-file', params),
  aiWorkspaceClear: (workspaceId: string): Promise<{ removed: number }> =>
    ipcRenderer.invoke('ai-workspace:clear', workspaceId),
  aiWorkspaceDelete: (workspaceId: string): Promise<{ deleted: boolean }> =>
    ipcRenderer.invoke('ai-workspace:delete', workspaceId),
  aiWorkspaceReadFile: (path: string): Promise<AiWorkspaceReadFileResult> =>
    ipcRenderer.invoke('ai-workspace:read-file', path),
  aiWorkspaceWriteFile: (params: {
    path: string
    text: string
    expectedMtimeMs?: number | null
  }): Promise<AiWorkspaceWriteFileResult> =>
    ipcRenderer.invoke('ai-workspace:write-file', params),
  onAiWorkspaceOpenRequest: (
    cb: (request: AiWorkspaceOpenRequest) => void,
  ): Unsub => subscribe('ai-workspace:open-request', cb),
}
