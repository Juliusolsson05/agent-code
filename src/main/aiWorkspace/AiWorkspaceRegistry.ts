import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { access, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { STATE_DIR } from '@main/storage/paths.js'
import { preserveInvalidBytes } from '@main/storage/preserveInvalidBytes.js'
import { getToolPath } from '@main/setup/toolchain.js'
import {
  atomicWriteTextFile,
  readBoundedTextFile,
  serializeEditorFileMutation,
} from '@main/editorFileIO.js'
import type {
  AiWorkspaceAttachFileParams,
  AiWorkspaceCreateParams,
  AiWorkspaceDetachFileParams,
  AiWorkspaceFileEntry,
  AiWorkspaceFileStatus,
  AiWorkspaceReadFileResult,
  AiWorkspaceRecord,
  AiWorkspaceSummary,
  AiWorkspaceWriteFileParams,
  AiWorkspaceWriteFileResult,
  AiWorkspaceChangeEvent,
} from '@mcp/shared/aiWorkspaceTypes.js'

const execFileAsync = promisify(execFile)
const AI_WORKSPACE_FILE = `${STATE_DIR}/ai-workspaces.json`
const STATUS_REFRESH_CONCURRENCY = 12
const GIT_CONTEXT_CACHE_TTL_MS = 5_000
const MAX_AI_WORKSPACE_FILE_BYTES = 8 * 1_048_576

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

const UNKNOWN_STATUS: AiWorkspaceFileStatus = {
  exists: false,
  readable: false,
  staleReason: 'status unknown; refresh the workspace',
  size: null,
  mtimeMs: null,
}

function usableWorkspace(raw: unknown): raw is AiWorkspaceRecord {
  const workspace = raw as AiWorkspaceRecord | null
  return workspace !== null && typeof workspace === 'object'
    && typeof workspace.workspaceId === 'string' && typeof workspace.name === 'string'
    && typeof workspace.createdAt === 'string' && typeof workspace.updatedAt === 'string'
    && Array.isArray(workspace.entries)
}

function usableEntry(raw: unknown): raw is AiWorkspaceRecord['entries'][number] {
  const entry = raw as AiWorkspaceRecord['entries'][number] | null
  return entry !== null && typeof entry === 'object'
    && typeof entry.entryId === 'string' && typeof entry.path === 'string'
}

function usableStatus(raw: unknown): boolean {
  const status = raw as AiWorkspaceFileStatus | null
  return status !== null && typeof status === 'object'
    && typeof status.exists === 'boolean' && typeof status.readable === 'boolean'
}

// WHY optional and display fields are repaired field by field (#1260 review
// A): a row that passes the identity checks still reaches the renderer, and
// one `description: {}` made the command palette's text helper throw, taking
// the whole picker down. A mistyped optional field is dropped; a mistyped
// required display field gets the value the UI would derive anyway.
function withUsableWorkspaceFields(workspace: AiWorkspaceRecord): AiWorkspaceRecord {
  const repaired: AiWorkspaceRecord = { ...workspace }
  if (repaired.description !== undefined && typeof repaired.description !== 'string') delete repaired.description
  if (repaired.scope !== undefined && !isPlainObject(repaired.scope)) delete repaired.scope
  return repaired
}

function withUsableEntryFields(entry: AiWorkspaceFileEntry, fallbackAttachedAt: string): AiWorkspaceFileEntry {
  const repaired: AiWorkspaceFileEntry = { ...entry }
  if (typeof repaired.title !== 'string') repaired.title = basename(repaired.path)
  if (typeof repaired.attachedAt !== 'string') repaired.attachedAt = fallbackAttachedAt
  for (const field of ['description', 'sourceSessionId', 'sourceAgentLabel', 'taskId', 'projectRoot', 'gitBranch'] as const) {
    if (repaired[field] !== undefined && typeof repaired[field] !== 'string') delete repaired[field]
  }
  if (repaired.metadata !== undefined && !isPlainObject(repaired.metadata)) delete repaired.metadata
  return repaired
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
    // Resolve through the setup toolchain like every other git caller
    // (ipc/git.ts) instead of a bare PATH-dependent 'git' (#495 A5
    // consistency fix). A Finder-launched app inherits launchd's minimal
    // PATH; the setup-cached absolute path is the one the user actually
    // validated. Fallback stays 'git' so a machine that never ran setup
    // behaves exactly as before.
    const { stdout } = await execFileAsync(getToolPath('git', 'git'), ['-C', cwd, ...args], {
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

export interface AiWorkspaceRegistry {
  on(event: 'changed', listener: (event: AiWorkspaceChangeEvent) => void): this
  off(event: 'changed', listener: (event: AiWorkspaceChangeEvent) => void): this
  emit(event: 'changed', payload: AiWorkspaceChangeEvent): boolean
}

export class AiWorkspaceRegistry extends EventEmitter {
  private readonly workspaces = new Map<string, AiWorkspaceRecord>()
  private loadPromise: Promise<void> | null = null
  /** The loaded file while set-aside rows are not yet preserved; see load(). */
  private owedCopy: { text: string; setAside: number } | null = null
  private saveQueue: Promise<void> = Promise.resolve()
  private readonly knownFilePaths = new Set<string>()
  private readonly gitContextCache = new Map<
    string,
    {
      expiresAt: number
      promise: Promise<{
        projectRoot?: string
        gitBranch?: string
      }>
    }
  >()

  constructor(private readonly stateFile = AI_WORKSPACE_FILE) {
    super()
  }

  async create(params: AiWorkspaceCreateParams): Promise<AiWorkspaceRecord> {
    await this.ensureWritable()
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
    this.emit('changed', {
      workspaceId: workspace.workspaceId,
      kind: 'created',
    })
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
        staleCount: workspace.entries.filter(
          entry => !entry.status.exists || !entry.status.readable,
        ).length,
      }))
  }

  async authorizeLspEntry(
    workspaceId: string,
    entryId: string,
  ): Promise<{ workspaceRoot: string; filePath: string }> {
    await this.ensureLoaded()
    const workspace = this.requiredWorkspace(workspaceId)
    const entry = workspace.entries.find(candidate => candidate.entryId === entryId)
    if (!entry?.projectRoot) throw new Error('AI Workspace entry has no project root')
    const workspaceRoot = await realpath(resolve(entry.projectRoot))
    const physicalFile = await realpath(resolve(entry.path))
    const filePath = relative(workspaceRoot, physicalFile)
    if (
      !filePath ||
      filePath === '..' ||
      filePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      isAbsolute(filePath)
    ) {
      throw new Error('AI Workspace entry is outside its project root')
    }
    const fileStat = await stat(physicalFile)
    if (!fileStat.isFile()) throw new Error('AI Workspace entry is not a file')
    return { workspaceRoot, filePath }
  }

  async get(workspaceId: string): Promise<AiWorkspaceRecord | null> {
    await this.ensureLoaded()
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) return null
    return await this.refreshWorkspace(workspaceId)
  }

  async attachFile(params: AiWorkspaceAttachFileParams): Promise<AiWorkspaceFileEntry> {
    await this.ensureWritable()
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
    // Store the physical path once at capability creation. Without this, an
    // attached symlink and its target become two spellings of the same file,
    // LSP definitions (which use physical file URIs) cannot match the curated
    // entry, and swapping the final symlink can silently redirect later saves.
    const path = await realpath(normalizePath(params.path))
    const fileStat = await stat(path)
    if (!fileStat.isFile()) throw new Error('AI Workspace can only attach files')
    // Process-lifetime capability: detaching/clearing metadata must not make an
    // already-open buffer suddenly unable to save, but an arbitrary renderer
    // path must never mint filesystem authority merely by invoking read/write.
    this.knownFilePaths.add(path)

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
    this.emit('changed', {
      workspaceId: workspace.workspaceId,
      kind: 'entries',
    })
    return entry
  }

  async detachFile(
    params: AiWorkspaceDetachFileParams,
  ): Promise<{ removed: boolean; remaining: number }> {
    await this.ensureWritable()
    const workspace = this.requiredWorkspace(params.workspaceId)
    const normalized = params.path
      ? await realpath(normalizePath(params.path)).catch(() => normalizePath(params.path!))
      : null
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
      this.emit('changed', {
        workspaceId: workspace.workspaceId,
        kind: 'entries',
      })
    }
    return { removed, remaining: workspace.entries.length }
  }

  async clear(workspaceId: string): Promise<{ removed: number }> {
    await this.ensureWritable()
    const workspace = this.requiredWorkspace(workspaceId)
    const removed = workspace.entries.length
    workspace.entries = []
    workspace.updatedAt = nowIso()
    await this.save()
    if (removed > 0) this.emit('changed', { workspaceId, kind: 'entries' })
    return { removed }
  }

  async delete(workspaceId: string): Promise<{ deleted: boolean }> {
    await this.ensureWritable()
    const deleted = this.workspaces.delete(workspaceId)
    if (deleted) {
      await this.save()
      this.emit('changed', { workspaceId, kind: 'deleted' })
    }
    return { deleted }
  }

  async readFile(path: string): Promise<AiWorkspaceReadFileResult> {
    try {
      await this.ensureLoaded()
      const target = normalizePath(path)
      if (!this.knownFilePaths.has(target)) return { ok: false, error: 'file is not attached' }
      const read = await readBoundedTextFile(target, MAX_AI_WORKSPACE_FILE_BYTES).catch(err => {
        if ((err as Error).message === 'file is too large') {
          throw new Error('file is too large to open in the editor')
        }
        throw err
      })
      return {
        ok: true,
        path: target,
        text: read.text,
        mtimeMs: read.stat.mtimeMs,
        size: read.stat.size,
        version: read.version,
      }
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  }

  async writeFile(params: AiWorkspaceWriteFileParams): Promise<AiWorkspaceWriteFileResult> {
    try {
      await this.ensureLoaded()
      const target = normalizePath(params.path)
      if (!this.knownFilePaths.has(target)) return { ok: false, error: 'file is not attached' }
      return await serializeEditorFileMutation(target, async () => {
        const result = await atomicWriteTextFile({
          absolutePath: target,
          text: params.text,
          expectedVersion: params.expectedVersion,
          maxBytes: MAX_AI_WORKSPACE_FILE_BYTES,
        })
        if (!result.ok) {
          return {
            ok: false,
            error:
              result.conflictKind === 'deleted'
                ? 'file was deleted on disk'
                : 'file changed on disk',
            conflict: true,
            conflictKind: result.conflictKind,
          }
        }
        await this.refreshEntriesForPath(target)
        // One physical file can be curated into several workspaces. Every
        // visible consumer needs the write signal; choosing an arbitrary first
        // workspace would leave the others showing stale buffer metadata.
        for (const workspace of this.workspaces.values()) {
          if (workspace.entries.some(entry => entry.path === target)) {
            this.emit('changed', {
              workspaceId: workspace.workspaceId,
              kind: 'file-written',
            })
          }
        }
        return {
          ok: true,
          path: target,
          mtimeMs: result.stat.mtimeMs,
          size: result.stat.size,
          version: result.version,
        }
      })
    } catch (err) {
      return { ok: false, error: errorMessage(err) }
    }
  }

  /** For every user mutation: the owed evidence copy (see load()) is made
   *  BEFORE memory changes (#1260 round 2). Checking only inside save() let
   *  create() insert a workspace, fail its save, and then report it as
   *  created on a retry, although it was never written. */
  private async ensureWritable(): Promise<void> {
    await this.ensureLoaded()
    await this.preserveOwedCopy()
  }

  private async ensureLoaded(): Promise<void> {
    // A failed load is not cached (#1246): a transient read error used to
    // fail every AI Workspace operation for the rest of the process.
    this.loadPromise ??= this.load().catch(error => {
      this.loadPromise = null
      throw error
    })
    await this.loadPromise
  }

  private async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.stateFile, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    const parsed = JSON.parse(text) as { workspaces?: unknown }
    // A malformed CONTAINER still refuses: every save rewrites the whole
    // file, so migrating it as empty would erase whatever it held.
    //
    // The `workspaces` list must be PRESENT (#1260 review): every file this
    // store writes carries it, so an object without it (a typo'd key, a
    // top-level list, another program's JSON) was not written here, and
    // loading it as zero workspaces let the next save erase it uncopied.
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.workspaces)) {
      throw new Error('AI Workspace storage is invalid; the original file is untouched.')
    }
    // WHY per-row validation (#1246): one row with a non-string path threw in
    // resolve(), the rejected load was cached, and every operation failed for
    // the rest of the process; list() also read updatedAt and entry.status
    // unguarded. A bad workspace or entry is set aside for itself, the file's
    // bytes are preserved before the next save can drop it, and an entry
    // whose only damage is its cached status keeps a status of "unknown"
    // (statuses are a refreshable cache, not the user's data).
    let setAside = 0
    const workspaces: AiWorkspaceRecord[] = []
    for (const raw of (parsed.workspaces ?? []) as unknown[]) {
      if (!usableWorkspace(raw)) {
        setAside++
        continue
      }
      const entries: AiWorkspaceRecord['entries'] = []
      for (const entry of raw.entries) {
        if (!usableEntry(entry)) {
          setAside++
          continue
        }
        // A REPAIR counts like a set-aside row (#1260 round 2): the next save
        // writes the repaired values, so the original bytes must be copied
        // first or a recoverable value (say, a description stored as an
        // object) is lost without evidence.
        if (!usableStatus(entry.status)) {
          entry.status = { ...UNKNOWN_STATUS }
          setAside++
        }
        const usable = withUsableEntryFields(entry, raw.createdAt)
        if (JSON.stringify(usable) !== JSON.stringify(entry)) setAside++
        entries.push(usable)
      }
      const workspace = withUsableWorkspaceFields({ ...raw, entries })
      if (JSON.stringify({ ...workspace, entries: [] }) !== JSON.stringify({ ...raw, entries: [] })) setAside++
      workspaces.push(workspace)
    }
    if (setAside > 0) {
      // A failed copy must not fail the load (#1257 review B, same rule): the
      // rows are only dropped by a SAVE, so the copy is owed before the next
      // save instead, which retries it and is refused while it fails.
      this.owedCopy = { text, setAside }
      await this.preserveOwedCopy().catch(error => {
        console.warn(`[ai-workspace] could not preserve ${setAside} malformed row(s) yet; saves wait for it:`, error)
      })
    }
    for (const workspace of workspaces) {
      for (const entry of workspace.entries) {
        const normalized = normalizePath(entry.path)
        // Migrate live legacy symlink entries in memory so their editor and
        // LSP identities agree. Stale references intentionally retain their
        // lexical path: preserving a useful broken-link explanation is more
        // valuable than dropping an entry merely because realpath fails.
        entry.path = await realpath(normalized).catch(() => normalized)
      }
      this.workspaces.set(workspace.workspaceId, workspace)
      for (const entry of workspace.entries) this.knownFilePaths.add(normalizePath(entry.path))
    }
    // Stored statuses are allowed to be slightly stale at startup.
    // Refreshing all references here made first use perform an uncapped
    // filesystem sweep. The selected workspace is refreshed when opened.
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
      const fileStat = knownStats ?? (await stat(path))
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

  private async preserveOwedCopy(): Promise<void> {
    if (!this.owedCopy) return
    const { text, setAside } = this.owedCopy
    const copy = await preserveInvalidBytes(`${this.stateFile}.invalid`, text)
    this.owedCopy = null
    console.warn(`[ai-workspace] set aside ${setAside} malformed row(s); original preserved at ${copy}`)
  }

  private async save(): Promise<void> {
    const next = this.saveQueue.then(async () => {
      await this.preserveOwedCopy()
      await this.writeStateFile()
    })
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
