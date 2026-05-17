export type AiWorkspaceScope = {
  parentSessionId?: string
  taskId?: string
  issueId?: string
  cwd?: string
  [key: string]: unknown
}

export type AiWorkspaceFileStatus = {
  exists: boolean
  readable: boolean
  staleReason: string | null
  size: number | null
  mtimeMs: number | null
}

export type AiWorkspaceFileEntry = {
  entryId: string
  path: string
  title: string
  description?: string
  sourceSessionId?: string
  sourceAgentLabel?: string
  taskId?: string
  metadata?: Record<string, unknown>
  projectRoot?: string
  gitBranch?: string
  attachedAt: string
  status: AiWorkspaceFileStatus
}

export type AiWorkspaceRecord = {
  workspaceId: string
  name: string
  description?: string
  scope?: AiWorkspaceScope
  createdAt: string
  updatedAt: string
  entries: AiWorkspaceFileEntry[]
}

export type AiWorkspaceSummary = {
  workspaceId: string
  name: string
  description?: string
  scope?: AiWorkspaceScope
  createdAt: string
  updatedAt: string
  fileCount: number
  staleCount: number
}

export type AiWorkspaceCreateParams = {
  name: string
  description?: string
  scope?: AiWorkspaceScope
}

export type AiWorkspaceAttachFileParams = {
  workspaceId: string
  path: string
  title?: string
  description?: string
  sourceSessionId?: string
  sourceAgentLabel?: string
  taskId?: string
  metadata?: Record<string, unknown>
}

export type AiWorkspaceDetachFileParams = {
  workspaceId: string
  path?: string
  entryId?: string
}

export type AiWorkspaceReadFileResult =
  | { ok: true; path: string; text: string; mtimeMs: number; size: number }
  | { ok: false; error: string }

export type AiWorkspaceWriteFileResult =
  | { ok: true; path: string; mtimeMs: number; size: number }
  | { ok: false; error: string; conflict?: boolean }

export type AiWorkspaceOpenRequest = {
  workspaceId: string
}
