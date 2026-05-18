export type EditorFsCacheEntry = {
  name: string
  path: string
  isDirectory: boolean
  size: number | null
  mtimeMs: number
}

export type EditorFsCachedRead = {
  path: string
  text: string
  mtimeMs: number
  size: number
}

type DirectoryRecord = {
  root: string
  path: string
  showHidden: boolean
  mtimeMs: number
  size: number
  cachedAt: number
  entries: EditorFsCacheEntry[]
}

type FileRecord = {
  root: string
  path: string
  mtimeMs: number
  size: number
  cachedAt: number
  read: EditorFsCachedRead
}

export type EditorFsCacheOptions = {
  ttlMs?: number
  maxDirectories?: number
  maxFiles?: number
  maxFileBytes?: number
  now?: () => number
}

const DEFAULT_TTL_MS = 30_000
const DEFAULT_MAX_DIRECTORIES = 500
const DEFAULT_MAX_FILES = 100
const DEFAULT_MAX_FILE_BYTES = 512 * 1024

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
}

function parentPath(path: string): string {
  const normalized = normalizePath(path)
  if (!normalized) return ''
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? '' : normalized.slice(0, idx)
}

function directoryKey(root: string, path: string, showHidden: boolean): string {
  return `${root}\0${normalizePath(path)}\0${showHidden ? '1' : '0'}`
}

function fileKey(root: string, path: string): string {
  return `${root}\0${normalizePath(path)}`
}

function isSameOrDescendant(candidate: string, path: string): boolean {
  if (!path) return true
  return candidate === path || candidate.startsWith(`${path}/`)
}

function cloneEntries(entries: EditorFsCacheEntry[]): EditorFsCacheEntry[] {
  return entries.map(entry => ({ ...entry }))
}

function cloneRead(read: EditorFsCachedRead): EditorFsCachedRead {
  return { ...read }
}

function evictOldest<K, V extends { cachedAt: number }>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    let oldestKey: K | null = null
    let oldestAt = Infinity
    for (const [key, value] of map) {
      if (value.cachedAt < oldestAt) {
        oldestAt = value.cachedAt
        oldestKey = key
      }
    }
    if (oldestKey === null) return
    map.delete(oldestKey)
  }
}

export class EditorFsCache {
  private readonly ttlMs: number
  private readonly maxDirectories: number
  private readonly maxFiles: number
  private readonly maxFileBytes: number
  private readonly now: () => number
  private readonly directories = new Map<string, DirectoryRecord>()
  private readonly files = new Map<string, FileRecord>()

  constructor(options: EditorFsCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.maxDirectories = options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES
    this.now = options.now ?? Date.now
  }

  getDirectory(params: {
    root: string
    path: string
    showHidden: boolean
    mtimeMs: number
    size: number
  }): EditorFsCacheEntry[] | null {
    const key = directoryKey(params.root, params.path, params.showHidden)
    const record = this.directories.get(key)
    if (!record) return null
    const expired = this.now() - record.cachedAt > this.ttlMs
    if (expired || record.mtimeMs !== params.mtimeMs || record.size !== params.size) {
      this.directories.delete(key)
      return null
    }
    return cloneEntries(record.entries)
  }

  setDirectory(params: {
    root: string
    path: string
    showHidden: boolean
    mtimeMs: number
    size: number
    entries: EditorFsCacheEntry[]
  }): void {
    this.directories.set(directoryKey(params.root, params.path, params.showHidden), {
      root: params.root,
      path: normalizePath(params.path),
      showHidden: params.showHidden,
      mtimeMs: params.mtimeMs,
      size: params.size,
      cachedAt: this.now(),
      entries: cloneEntries(params.entries),
    })
    evictOldest(this.directories, this.maxDirectories)
  }

  getTextFile(params: {
    root: string
    path: string
    mtimeMs: number
    size: number
  }): EditorFsCachedRead | null {
    const key = fileKey(params.root, params.path)
    const record = this.files.get(key)
    if (!record) return null
    const expired = this.now() - record.cachedAt > this.ttlMs
    if (expired || record.mtimeMs !== params.mtimeMs || record.size !== params.size) {
      this.files.delete(key)
      return null
    }
    return cloneRead(record.read)
  }

  setTextFile(params: { root: string; path: string; read: EditorFsCachedRead }): void {
    if (params.read.size > this.maxFileBytes) {
      this.files.delete(fileKey(params.root, params.path))
      return
    }
    this.files.set(fileKey(params.root, params.path), {
      root: params.root,
      path: normalizePath(params.path),
      mtimeMs: params.read.mtimeMs,
      size: params.read.size,
      cachedAt: this.now(),
      read: cloneRead(params.read),
    })
    evictOldest(this.files, this.maxFiles)
  }

  invalidatePath(root: string, path: string): void {
    const normalized = normalizePath(path)
    // WHY invalidation deliberately clears both the mutated path and its
    // parent directory: editor operations can change the selected file's
    // contents, the selected directory's children, and the row that appears in
    // its parent. A broad, bounded in-memory sweep is cheaper than maintaining
    // a complex dependency graph for a cache whose whole purpose is avoiding
    // repeat reads during short-lived editor interactions.
    const parents = new Set([parentPath(normalized)])
    if (!normalized) parents.add('')

    for (const [key, record] of this.files) {
      if (record.root === root && isSameOrDescendant(record.path, normalized)) {
        this.files.delete(key)
      }
    }
    for (const [key, record] of this.directories) {
      if (
        record.root === root &&
        (isSameOrDescendant(record.path, normalized) || parents.has(record.path))
      ) {
        this.directories.delete(key)
      }
    }
  }

  clear(): void {
    this.directories.clear()
    this.files.clear()
  }
}
