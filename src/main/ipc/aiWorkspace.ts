import { ipcMain } from 'electron'

import type { AiWorkspaceRegistry } from '@main/aiWorkspace/AiWorkspaceRegistry.js'
import type {
  AiWorkspaceAttachFileParams,
  AiWorkspaceCreateParams,
  AiWorkspaceDetachFileParams,
  AiWorkspaceWriteFileParams,
} from '@mcp/shared/aiWorkspaceTypes.js'

export function registerAiWorkspaceIpc(registry: AiWorkspaceRegistry): void {
  ipcMain.handle('ai-workspace:create', (_evt, params: AiWorkspaceCreateParams) =>
    registry.create(params),
  )
  ipcMain.handle('ai-workspace:list', () => registry.list())
  ipcMain.handle('ai-workspace:get', (_evt, workspaceId: string) =>
    registry.get(workspaceId),
  )
  ipcMain.handle('ai-workspace:attach-file', (_evt, params: AiWorkspaceAttachFileParams) =>
    registry.attachFile(params),
  )
  ipcMain.handle('ai-workspace:detach-file', (_evt, params: AiWorkspaceDetachFileParams) =>
    registry.detachFile(params),
  )
  ipcMain.handle('ai-workspace:clear', (_evt, workspaceId: string) =>
    registry.clear(workspaceId),
  )
  ipcMain.handle('ai-workspace:delete', (_evt, workspaceId: string) =>
    registry.delete(workspaceId),
  )
  ipcMain.handle('ai-workspace:read-file', (_evt, path: string) =>
    registry.readFile(path),
  )
  ipcMain.handle(
    'ai-workspace:write-file',
    (_evt, params: AiWorkspaceWriteFileParams) => registry.writeFile(params),
  )
}
