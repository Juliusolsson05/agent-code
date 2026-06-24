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

// WHY a named params type (it was inlined identically in preload, the main IPC
// handler, and AiWorkspaceRegistry.writeFile): `expectedMtimeMs` is the
// optimistic-concurrency guard. If its optionality/nullability drifts between
// the three sites, the renderer could send a guard the writer ignores (lost
// conflict detection) or omit one the writer requires (spurious conflicts).
// One shape keeps the guard semantics aligned end to end.
export type AiWorkspaceWriteFileParams = {
  path: string
  text: string
  /** Last mtime the renderer saw. Omit/undefined to write unconditionally;
   *  `null` is treated the same as undefined by the writer. A mismatch yields
   *  a `{ ok: false, conflict: true }` result. */
  expectedMtimeMs?: number | null
}

export type AiWorkspaceWriteFileResult =
  | { ok: true; path: string; mtimeMs: number; size: number }
  | { ok: false; error: string; conflict?: boolean }

export type AiWorkspaceOpenRequest = {
  workspaceId: string
}
