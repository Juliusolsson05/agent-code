import { randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { STATE_DIR } from '@main/storage/paths.js'
import type {
  AiWorkspaceAttachFileParams,
  AiWorkspaceCreateParams,
  AiWorkspaceDetachFileParams,
  AiWorkspaceFileEntry,
  AiWorkspaceFileStatus,
  AiWorkspaceReadFileResult,
  AiWorkspaceRecord,
  AiWorkspaceSummary,
  AiWorkspaceWriteFileResult,
} from '@mcp/shared/aiWorkspaceTypes.js'

const execFileAsync = promisify(execFile)
const AI_WORKSPACE_FILE = `${STATE_DIR}/ai-workspaces.json`
const STATUS_REFRESH_CONCURRENCY = 12
const GIT_CONTEXT_CACHE_TTL_MS = 5_000

type PersistedAiWorkspaceState = {
  workspaces: AiWorkspaceRecord[]
}

function nowIso(): string {
  return new Date().toISOString()
}

function errorMessage(err: unknown): string {
  const e = err as NodeJS.ErrnoException
  if (e.code === 'ENOENT') return 'does not exist'
  if (e.code === 'EISDIR') return 'is a directory'
  if (e.code === 'EACCES' || e.code === 'EPERM') return 'permission denied'
  return e.message ?? 'filesystem operation failed'
}

function normalizePath(path: string): string {
  return resolve(path)
}

function sameScope(
  a: AiWorkspaceCreateParams['scope'],
  b: AiWorkspaceCreateParams['scope'],
): boolean {
  return stableStringify(a ?? null) === stableStringify(b ?? null)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const record = value as Record<string, unknown>
  const entries = Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
  return `{${entries.join(',')}}`
}

async function gitField(cwd: string, args: string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout: 1500,
    })
    const value = stdout.trim()
    return value.length > 0 ? value : undefined
  } catch {
    return undefined
  }
}

async function detectGitContext(path: string): Promise<{
  projectRoot?: string
  gitBranch?: string
}> {
  const cwd = dirname(path)
  const projectRoot = await gitField(cwd, ['rev-parse', '--show-toplevel'])
  const gitBranch = await gitField(cwd, ['branch', '--show-current'])
  return { projectRoot, gitBranch }
}

export class AiWorkspaceRegistry {
  private readonly workspaces = new Map<string, AiWorkspaceRecord>()
  private loadPromise: Promise<void> | null = null
  private saveQueue: Promise<void> = Promise.resolve()
  private readonly gitContextCache = new Map<string, {
    expiresAt: number
    promise: Promise<{
      projectRoot?: string
      gitBranch?: string
    }>
  }>()

  constructor(private readonly stateFile = AI_WORKSPACE_FILE) {}

  async create(params: AiWorkspaceCreateParams): Promise<AiWorkspaceRecord> {
    await this.ensureLoaded()
    const name = params.name.trim()
    if (!name) throw new Error('AI Workspace name is required')

    const existing = [...this.workspaces.values()].find(
      workspace => workspace.name === name && sameScope(workspace.scope, params.scope),
    )
    if (existing) return await this.refreshWorkspace(existing.workspaceId)

    const timestamp = nowIso()
    const workspace: AiWorkspaceRecord = {
      workspaceId: randomUUID(),
      name,
      ...(params.description ? { description: params.description } : {}),
      ...(params.scope ? { scope: params.scope } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
      entries: [],
    }
    this.workspaces.set(workspace.workspaceId, workspace)
    await this.save()
    return workspace
  }

  async list(): Promise<AiWorkspaceSummary[]> {
    await this.ensureLoaded()
    // Listing is used by command-palette modes and MCP discovery-style
    // flows where callers need names/counts, not a fresh filesystem truth
    // pass over every attached file. Preserve the last known status here;
    // `get`, attach, and write paths still refresh real files.
    return [...this.workspaces.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(workspace => ({
        workspaceId: workspace.workspaceId,
        name: workspace.name,
        ...(workspace.description ? { description: workspace.description } : {}),
        ...(workspace.scope ? { scope: workspace.scope } : {}),
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
        fileCount: workspace.entries.length,
        staleCount: workspace.entries.filter(entry => !entry.status.exists || !entry.status.readable).length,
      }))
  }

  async get(workspaceId: string): Promise<AiWorkspaceRecord | null> {
    await this.ensureLoaded()
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) return null
    return await this.refreshWorkspace(workspaceId)
  }

  async attachFile(params: AiWorkspaceAttachFileParams): Promise<AiWorkspaceFileEntry> {
    await this.ensureLoaded()
    const workspace = this.requiredWorkspace(params.workspaceId)
    // WHY AI Workspace accepts absolute paths instead of forcing project-root
    // containment:
    //
    // The feature exists specifically for cross-worktree review. A useful
    // workspace may contain files from sibling worktrees, generated reports in
    // /tmp, or artifacts produced by another visible agent in a different cwd.
    // The registry stores references only and validates "existing readable
    // file"; it does not grant the model new filesystem authority. The user
    // still opens the real path explicitly in Agent Code's UI, with stale /
    // unreadable status visible instead of silently pruning references.
    const path = normalizePath(params.path)
    const fileStat = await stat(path)
    if (!fileStat.isFile()) throw new Error('AI Workspace can only attach files')

    const status = await this.statusForPath(path, fileStat)
    const git = await this.detectGitContextCached(path)
    const existingIdx = workspace.entries.findIndex(entry => entry.path === path)
    const timestamp = nowIso()
    const entry: AiWorkspaceFileEntry = {
      entryId: existingIdx >= 0 ? workspace.entries[existingIdx].entryId : randomUUID(),
      path,
      title: params.title?.trim() || basename(path),
      ...(params.description ? { description: params.description } : {}),
      ...(params.sourceSessionId ? { sourceSessionId: params.sourceSessionId } : {}),
      ...(params.sourceAgentLabel ? { sourceAgentLabel: params.sourceAgentLabel } : {}),
      ...(params.taskId ? { taskId: params.taskId } : {}),
      ...(params.metadata ? { metadata: params.metadata } : {}),
      ...(git.projectRoot ? { projectRoot: git.projectRoot } : {}),
      ...(git.gitBranch ? { gitBranch: git.gitBranch } : {}),
      attachedAt: existingIdx >= 0 ? workspace.entries[existingIdx].attachedAt : timestamp,
      status,
    }
    if (existingIdx >= 0) workspace.entries[existingIdx] = entry
    else workspace.entries.push(entry)
    workspace.updatedAt = timestamp
    await this.save()
    return entry
  }

  async detachFile(params: AiWorkspaceDetachFileParams): Promise<{ removed: boolean; remaining: number }> {
    await this.ensureLoaded()
    const workspace = this.requiredWorkspace(params.workspaceId)
    const normalized = params.path ? normalizePath(params.path) : null
    const before = workspace.entries.length
    workspace.entries = workspace.entries.filter(entry => {
      if (params.entryId && entry.entryId === params.entryId) return false
      if (normalized && entry.path === normalized) return false
      return true
    })
    const removed = workspace.entries.length !== before
    if (removed) {
      workspace.updatedAt = nowIso()
      await this.save()
    }
    return { removed, remaining: workspace.entries.length }
  }

  async clear(workspaceId: string): Promise<{ removed: number }> {
    await this.ensureLoaded()
    const workspace = this.requiredWorkspace(workspaceId)
    const removed = workspace.entries.length
    workspace.entries = []
    workspace.updatedAt = nowIso()
    await this.save()
    return { removed }
  }

  async delete(workspaceId: string): Promise<{ deleted: boolean }> {
    await this.ensureLoaded()
    const deleted = this.workspaces.delete(workspaceId)
    if (deleted) await this.save()
    return { deleted }
  }

  async readFile(path: string): Promise<AiWorkspaceReadFileResult> {
    try {
      const target = normalizePath(path)
      const fileStat = await stat(target)
      if (!fileStat.isFile()) return { ok: false, error: 'not a file' }
      const text = await readFile(target, 'utf8')
      return { ok: true, path: target, text, mtimeMs: fileStat.mtimeMs, size: fileStat.size }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  }

  async writeFile(params: {
    path: string
    text: string
    expectedMtimeMs?: number | null
  }): Promise<AiWorkspaceWriteFileResult> {
    try {
      const target = normalizePath(params.path)
      const before = await stat(target).catch(() => null)
      if (before && !before.isFile()) return { ok: false, error: 'not a file' }
      if (
        before &&
        typeof params.expectedMtimeMs === 'number' &&
        Math.abs(before.mtimeMs - params.expectedMtimeMs) > 1
      ) {
        return { ok: false, error: 'file changed on disk', conflict: true }
      }
      await writeFile(target, params.text, 'utf8')
      const after = await stat(target)
      await this.refreshEntriesForPath(target)
      return { ok: true, path: target, mtimeMs: after.mtimeMs, size: after.size }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  }

  private async ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load()
    await this.loadPromise
  }

  private async load(): Promise<void> {
    try {
      const text = await readFile(this.stateFile, 'utf8')
      const parsed = JSON.parse(text) as PersistedAiWorkspaceState
      for (const workspace of parsed.workspaces ?? []) {
        this.workspaces.set(workspace.workspaceId, workspace)
      }
      // Stored statuses are allowed to be slightly stale at startup.
      // Refreshing all references here made first use perform an uncapped
      // filesystem sweep. The selected workspace is refreshed when opened.
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
  }

  private requiredWorkspace(workspaceId: string): AiWorkspaceRecord {
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) throw new Error('AI Workspace not found')
    return workspace
  }

  private async refreshWorkspace(workspaceId: string): Promise<AiWorkspaceRecord> {
    const workspace = this.requiredWorkspace(workspaceId)
    workspace.entries = await mapWithConcurrency(
      workspace.entries,
      STATUS_REFRESH_CONCURRENCY,
      async entry => ({
        ...entry,
        status: await this.statusForPath(entry.path),
      }),
    )
    return workspace
  }

  private async refreshEntriesForPath(path: string): Promise<void> {
    await this.ensureLoaded()
    let changed = false
    for (const workspace of this.workspaces.values()) {
      for (const entry of workspace.entries) {
        if (entry.path !== path) continue
        entry.status = await this.statusForPath(path)
        changed = true
      }
    }
    if (changed) await this.save()
  }

  private async statusForPath(path: string, knownStats?: Stats): Promise<AiWorkspaceFileStatus> {
    try {
      const fileStat = knownStats ?? await stat(path)
      if (!fileStat.isFile()) {
        return {
          exists: true,
          readable: false,
          staleReason: 'not a file',
          size: null,
          mtimeMs: fileStat.mtimeMs,
        }
      }
      await access(path, constants.R_OK)
      return {
        exists: true,
        readable: true,
        staleReason: null,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
      }
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      return {
        exists: e.code !== 'ENOENT',
        readable: false,
        staleReason: errorMessage(err),
        size: null,
        mtimeMs: null,
      }
    }
  }

  private async save(): Promise<void> {
    const next = this.saveQueue.then(() => this.writeStateFile())
    this.saveQueue = next.catch(() => undefined)
    await next
  }

  private async writeStateFile(): Promise<void> {
    await mkdir(dirname(this.stateFile), { recursive: true })
    const payload: PersistedAiWorkspaceState = {
      workspaces: [...this.workspaces.values()],
    }
    // WHY AI Workspace persists outside workspace.json:
    //
    // The normal workspace state is renderer-owned layout/session data. AI
    // Workspace is main-owned MCP state: agents mutate it through tools even
    // when the renderer is only a consumer. Putting these records in their own
    // file avoids turning workspace.json into a cross-process database and
    // lets a future MCP-only mutation persist without waiting for renderer
    // autosave. The values are file references and metadata, never file
    // contents; stale files are preserved so the UI can explain broken links
    // instead of silently erasing the agent's review trail.
    const tmp = `${this.stateFile}.${process.pid}.${Date.now()}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`
    await writeFile(tmp, JSON.stringify(payload), 'utf8')
    await rename(tmp, this.stateFile)
  }

  private detectGitContextCached(path: string): Promise<{
    projectRoot?: string
    gitBranch?: string
  }> {
    const cwd = dirname(path)
    const now = Date.now()
    let cached = this.gitContextCache.get(cwd)
    if (!cached || cached.expiresAt <= now) {
      // Agent fan-outs commonly attach several files from the same report
      // directory. Share the two git subprocesses per directory instead of
      // multiplying them by file count during a burst of MCP attach calls.
      // Keep the cache deliberately short-lived: branch and worktree metadata
      // are context, not identity, and a long-lived process can switch branches
      // between review attachments.
      cached = {
        expiresAt: now + GIT_CONTEXT_CACHE_TTL_MS,
        promise: detectGitContext(path),
      }
      this.gitContextCache.set(cwd, cached)
    }
    return cached.promise
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      out[index] = await mapper(items[index], index)
    }
  })
  await Promise.all(workers)
  return out
}
