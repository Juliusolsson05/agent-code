import { ipcMain } from 'electron'
import { constants, type Dirent } from 'fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat, writeFile } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'

import { EditorFsCache } from './editorFsCache.js'
import type { EditorFsRootRegistry } from './editorFsRootRegistry.js'
// Result shapes are the shared renderer↔main contract. Importing them
// (instead of redeclaring) makes a field change here a compile error in
// preload/renderer rather than silent drift. Validation stays in this file.
import type {
  EditorFsEntry,
  EditorFsListResult,
  EditorFsReadResult,
  EditorFsWriteResult,
  EditorFsMutationResult,
  EditorFsRecursiveListResult,
  EditorFsSearchMatch,
  EditorFsSearchResult,
  EditorFsSearchStopReason,
} from '@shared/types/editorFs.js'

// WHY a hardcoded ignore list lives in main rather than the renderer:
//
//   The renderer is allowed to ask for any directory inside the project root,
//   so a junk filter that only runs in the UI still pays the readdir+stat cost
//   for every node_modules tree on the way in. Filtering at the source keeps
//   IPC payloads bounded, avoids spending tens of thousands of stat() calls on
//   a fresh `npm install`, and means a future quick-open / search surface gets
//   the same hygiene for free.
//
//   This list is intentionally project-wide, not gitignore-derived. .gitignore
//   parsing requires walking the entire ancestor chain plus reading `.git/info/
//   exclude` plus respecting nested ignore files; for "occasional editor"
//   semantics, a static list of vendored/build/cache directories covers the
//   real noise without that complexity. If a user wants to see one of these
//   they can pass `showHidden: true` (which now also disables this filter) or
//   we add an opt-in flag later. See features/editor/ui/ExplorerPane.tsx for
//   the toggle wiring; the contract is "showHidden reveals both dotfiles and
//   ignored junk so the explorer never silently lies about the tree".
const EDITOR_IGNORED_DIR_NAMES = new Set<string>([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.parcel-cache',
  '.cache',
  '.turbo',
  '.vite',
  '.expo',
  '.serverless',
  '.terraform',
  '.gradle',
  '.idea',
  '.vscode-test',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.venv',
  'venv',
  '__pycache__',
  '.yarn',
  '.pnpm-store',
  '.tsc-out',
  '.worktrees',
  'dist',
  'build',
  'out',
  'coverage',
  '.nyc_output',
])

// Junk files that always clutter trees but rarely matter when editing.
const EDITOR_IGNORED_FILE_NAMES = new Set<string>([
  '.DS_Store',
  'Thumbs.db',
  'npm-debug.log',
  'yarn-error.log',
])

function errorMessage(err: unknown): string {
  const e = err as NodeJS.ErrnoException
  if (e.code === 'ENOENT') return 'does not exist'
  if (e.code === 'ENOTDIR') return 'not a directory'
  if (e.code === 'EISDIR') return 'is a directory'
  if (e.code === 'EEXIST') return 'already exists'
  if (e.code === 'ELOOP') return 'symbolic links are not supported'
  if (e.code === 'EACCES' || e.code === 'EPERM') return 'permission denied'
  return e.message ?? 'filesystem operation failed'
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/')
}

// Exported for editorFsWatch.ts — the containment invariant must hold on
// EVERY editor-fs surface, including watch registration (a watch is
// read-signal only, but "renderer paths can never address outside the
// project root" is only a real invariant if there are zero exceptions).
export function resolveInsideRoot(root: string, path = ''): string {
  // Treat the IPC contract literally: editor paths are project-relative.
  // Silently stripping a leading slash used to turn an invalid absolute path
  // into a different, valid relative path. That remained contained, but it
  // made malformed/hostile requests act on surprising files instead of
  // failing closed. Check both native and Windows spellings because a request
  // can be replayed across platforms.
  if (
    typeof path !== 'string' ||
    path.includes('\0') ||
    isAbsolute(path) ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    /^[/\\]{2}/.test(path)
  ) {
    throw new Error('path must be relative to project root')
  }
  const rootAbs = resolve(root)
  const target = resolve(rootAbs, normalizeRelativePath(path))
  const rel = relative(rootAbs, target)
  // WHY this guard lives in main, not the renderer: every future editor
  // surface will eventually take user-controlled paths from clicks, fuzzy
  // search, rename dialogs, drag/drop, or extension-like automation. The
  // renderer is not the trust boundary. Keeping the containment check beside
  // the actual filesystem call means a UI bug can at worst ask for a bad path;
  // it cannot escape the project root and read or overwrite arbitrary files.
  if (
    rel === '..' ||
    rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
    isAbsolute(rel)
  ) {
    throw new Error('path escapes project root')
  }
  return target
}

function toProjectPath(root: string, abs: string): string {
  const rel = relative(resolve(root), abs).replace(/\\/g, '/')
  return rel === '' ? '' : rel
}

const editorFsCache = new EditorFsCache()
const searchGenerationByOwner = new WeakMap<object, number>()
const pendingRootMutations = new Map<string, Promise<void>>()

const MAX_TEXT_FILE_BYTES = 8 * 1_048_576
const NO_FOLLOW = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW

async function serializeRootMutation<T>(root: string, task: () => Promise<T>): Promise<T> {
  const previous = pendingRootMutations.get(root) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolveCurrent => {
    release = resolveCurrent
  })
  pendingRootMutations.set(root, current)
  await previous.catch(() => undefined)
  try {
    return await task()
  } finally {
    release()
    if (pendingRootMutations.get(root) === current) pendingRootMutations.delete(root)
  }
}

function isContained(root: string, target: string): boolean {
  const rel = relative(root, target)
  return (
    rel === '' ||
    (rel !== '..' &&
      !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      !isAbsolute(rel))
  )
}

export async function validateExistingTarget(root: string, target: string): Promise<void> {
  const leaf = await lstat(target)
  if (leaf.isSymbolicLink()) throw new Error('symbolic links are not supported')
  const canonical = await realpath(target)
  if (!isContained(root, canonical))
    throw new Error('path escapes project root through a symbolic link')
}

export function invalidateEditorFsCache(root: string, path: string): void {
  editorFsCache.invalidatePath(root, path)
}

async function validateExistingParent(root: string, target: string): Promise<void> {
  const canonicalParent = await realpath(dirname(target))
  if (!isContained(root, canonicalParent)) {
    throw new Error('path escapes project root through a symbolic link')
  }
}

export function registerEditorFsIpc(roots: EditorFsRootRegistry): void {
  ipcMain.handle(
    'editor-fs:list-directory',
    async (
      evt,
      params: { root: string; path?: string; showHidden?: boolean },
    ): Promise<EditorFsListResult> => {
      try {
        const root = await roots.authorize(evt.sender, params.root)
        const target = resolveInsideRoot(root, params.path ?? '')
        await validateExistingTarget(root, target)
        const targetPath = toProjectPath(root, target)
        const itemStat = await stat(target)
        if (!itemStat.isDirectory()) return { ok: false, error: 'not a directory' }
        const showHidden = params.showHidden === true
        const cached = editorFsCache.getDirectory({
          root,
          path: targetPath,
          showHidden,
          mtimeMs: itemStat.mtimeMs,
          size: itemStat.size,
        })
        if (cached) return { ok: true, root, path: targetPath, entries: cached }
        const entries: EditorFsEntry[] = []
        const dirents = await readdir(target, { withFileTypes: true })
        for (const dirent of dirents) {
          // The hidden gate covers both dotfiles AND the junk ignore list so
          // a single toggle in the UI gives the user the full unfiltered tree
          // rather than two confusingly partial reveals.
          if (!showHidden) {
            if (dirent.name.startsWith('.')) continue
            if (dirent.isDirectory()) {
              if (EDITOR_IGNORED_DIR_NAMES.has(dirent.name)) continue
            } else if (EDITOR_IGNORED_FILE_NAMES.has(dirent.name)) {
              continue
            }
          }
          if (!dirent.isDirectory() && !dirent.isFile()) continue
          const abs = join(target, dirent.name)
          entries.push({
            name: dirent.name,
            path: toProjectPath(root, abs),
            isDirectory: dirent.isDirectory(),
            // WHY list-directory intentionally does not stat every entry:
            // the explorer UI only needs name/path/type, and `Dirent` already
            // gives us the type from the readdir call. Serial stat() per row
            // made expanding a large source directory scale with thousands of
            // extra syscalls and a much larger IPC payload. Read/write paths
            // still stat the selected file where size/mtime are correctness
            // inputs for conflict detection.
            size: null,
            mtimeMs: 0,
          })
        }
        entries.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
          return a.name.localeCompare(b.name, undefined, {
            sensitivity: 'base',
          })
        })
        editorFsCache.setDirectory({
          root,
          path: targetPath,
          showHidden,
          mtimeMs: itemStat.mtimeMs,
          size: itemStat.size,
          entries,
        })
        return { ok: true, root, path: targetPath, entries }
      } catch (err) {
        return { ok: false, error: errorMessage(err) }
      }
    },
  )

  ipcMain.handle(
    'editor-fs:read-text-file',
    async (evt, params: { root: string; path: string }): Promise<EditorFsReadResult> => {
      try {
        const root = await roots.authorize(evt.sender, params.root)
        const target = resolveInsideRoot(root, params.path)
        await validateExistingTarget(root, target)
        const handle = await open(target, constants.O_RDONLY | NO_FOLLOW)
        try {
          const itemStat = await handle.stat()
          if (!itemStat.isFile()) return { ok: false, error: 'not a file' }
          if (itemStat.size > MAX_TEXT_FILE_BYTES) {
            return {
              ok: false,
              error: 'file is too large to open in the editor',
            }
          }
          const targetPath = toProjectPath(root, target)
          const cached = editorFsCache.getTextFile({
            root,
            path: targetPath,
            mtimeMs: itemStat.mtimeMs,
            size: itemStat.size,
          })
          if (cached) return { ok: true, ...cached }
          const text = await handle.readFile({ encoding: 'utf8' })
          const after = await handle.stat()
          if (after.size !== itemStat.size || Math.abs(after.mtimeMs - itemStat.mtimeMs) > 1) {
            return { ok: false, error: 'file changed while it was being read' }
          }
          const read = {
            path: targetPath,
            text,
            mtimeMs: after.mtimeMs,
            size: after.size,
          }
          editorFsCache.setTextFile({ root, path: targetPath, read })
          return { ok: true, ...read }
        } finally {
          await handle.close()
        }
      } catch (err) {
        return { ok: false, error: errorMessage(err) }
      }
    },
  )

  ipcMain.handle(
    'editor-fs:write-text-file',
    async (
      evt,
      params: {
        root: string
        path: string
        text: string
        expectedMtimeMs?: number | null
      },
    ): Promise<EditorFsWriteResult> => {
      try {
        const root = await roots.authorize(evt.sender, params.root)
        return await serializeRootMutation(root, async () => {
          const target = resolveInsideRoot(root, params.path)
          if (Buffer.byteLength(params.text, 'utf8') > MAX_TEXT_FILE_BYTES) {
            return {
              ok: false,
              error: 'file is too large to save from the editor',
            }
          }
          const exists = await lstat(target).then(
            () => true,
            err => {
              if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
              throw err
            },
          )
          if (!exists) {
            if (typeof params.expectedMtimeMs === 'number') {
              return {
                ok: false,
                error: 'file was deleted on disk',
                conflict: true,
              }
            }
            await validateExistingParent(root, target)
            await writeFile(target, params.text, {
              encoding: 'utf8',
              flag: 'wx',
            })
          } else {
            await validateExistingTarget(root, target)
            const handle = await open(target, constants.O_WRONLY | NO_FOLLOW)
            try {
              const before = await handle.stat()
              if (!before.isFile()) return { ok: false, error: 'not a file' }
              if (
                typeof params.expectedMtimeMs === 'number' &&
                Math.abs(before.mtimeMs - params.expectedMtimeMs) > 1
              ) {
                return {
                  ok: false,
                  error: 'file changed on disk',
                  conflict: true,
                }
              }
              await handle.truncate(0)
              await handle.writeFile(params.text, 'utf8')
              await handle.sync()
            } finally {
              await handle.close()
            }
          }
          const after = await stat(target)
          const targetPath = toProjectPath(root, target)
          editorFsCache.invalidatePath(root, targetPath)
          return {
            ok: true,
            path: targetPath,
            mtimeMs: after.mtimeMs,
            size: after.size,
          }
        })
      } catch (err) {
        return { ok: false, error: errorMessage(err) }
      }
    },
  )

  ipcMain.handle(
    'editor-fs:create-file',
    async (evt, params: { root: string; path: string }): Promise<EditorFsMutationResult> => {
      try {
        const root = await roots.authorize(evt.sender, params.root)
        return await serializeRootMutation(root, async () => {
          const target = resolveInsideRoot(root, params.path)
          await validateExistingParent(root, target)
          await writeFile(target, '', { encoding: 'utf8', flag: 'wx' })
          const targetPath = toProjectPath(root, target)
          editorFsCache.invalidatePath(root, targetPath)
          return { ok: true, path: targetPath }
        })
      } catch (err) {
        return { ok: false, error: errorMessage(err) }
      }
    },
  )

  ipcMain.handle(
    'editor-fs:create-directory',
    async (evt, params: { root: string; path: string }): Promise<EditorFsMutationResult> => {
      try {
        const root = await roots.authorize(evt.sender, params.root)
        return await serializeRootMutation(root, async () => {
          const target = resolveInsideRoot(root, params.path)
          await validateExistingParent(root, target)
          await mkdir(target)
          const targetPath = toProjectPath(root, target)
          editorFsCache.invalidatePath(root, targetPath)
          return { ok: true, path: targetPath }
        })
      } catch (err) {
        return { ok: false, error: errorMessage(err) }
      }
    },
  )

  ipcMain.handle(
    'editor-fs:rename',
    async (
      evt,
      params: { root: string; fromPath: string; toPath: string },
    ): Promise<EditorFsMutationResult> => {
      try {
        const root = await roots.authorize(evt.sender, params.root)
        return await serializeRootMutation(root, async () => {
          const from = resolveInsideRoot(root, params.fromPath)
          const to = resolveInsideRoot(root, params.toPath)
          await validateExistingTarget(root, from)
          await validateExistingParent(root, to)
          const destinationExists = await lstat(to).then(
            () => true,
            err => {
              if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
              throw err
            },
          )
          if (destinationExists) return { ok: false, error: 'already exists' }
          await rename(from, to)
          const fromPath = toProjectPath(root, from)
          const toPath = toProjectPath(root, to)
          editorFsCache.invalidatePath(root, fromPath)
          editorFsCache.invalidatePath(root, toPath)
          return { ok: true, path: toPath }
        })
      } catch (err) {
        return { ok: false, error: errorMessage(err) }
      }
    },
  )

  ipcMain.handle(
    'editor-fs:list-files-recursive',
    async (evt, params: { root: string }): Promise<EditorFsRecursiveListResult> => {
      try {
        const root = await roots.authorize(evt.sender, params.root)
        const rootStat = await stat(root)
        if (!rootStat.isDirectory()) return { ok: false, error: 'not a directory' }
        const files: string[] = []
        let errorCount = 0
        let truncated = false
        // Hard cap. Quick-open ranks client-side over the whole list; 20k
        // relative paths ≈ a few MB of IPC — fine once, not fine
        // unbounded (a rogue root near / would otherwise walk the disk).
        // `truncated` lets the UI say "index incomplete" instead of
        // silently lying about coverage.
        const LIMIT = 20_000
        const walk = async (dirAbs: string): Promise<void> => {
          let dirents: Dirent[]
          try {
            dirents = await readdir(dirAbs, { withFileTypes: true })
          } catch (err) {
            if (dirAbs === root) throw err
            errorCount += 1
            return
          }
          for (const dirent of dirents) {
            // Same hygiene as list-directory: dotfiles and the junk list
            // are invisible to quick-open. No showHidden variant on
            // purpose — quick-open is for project sources, and a hidden
            // file is one tree-toggle away in the explorer.
            if (dirent.name.startsWith('.')) continue
            if (dirent.isDirectory()) {
              if (EDITOR_IGNORED_DIR_NAMES.has(dirent.name)) continue
              await walk(join(dirAbs, dirent.name))
            } else if (dirent.isFile()) {
              if (EDITOR_IGNORED_FILE_NAMES.has(dirent.name)) continue
              if (files.length >= LIMIT) {
                truncated = true
                return
              }
              files.push(toProjectPath(root, join(dirAbs, dirent.name)))
            }
          }
        }
        await walk(root)
        return {
          ok: true,
          files,
          truncated,
          partial: errorCount > 0,
          errorCount,
        }
      } catch (err) {
        return { ok: false, error: errorMessage(err) }
      }
    },
  )

  ipcMain.handle(
    'editor-fs:search-content',
    async (
      evt,
      params: { root: string; query: string; caseSensitive?: boolean },
    ): Promise<EditorFsSearchResult> => {
      try {
        const root = await roots.authorize(evt.sender, params.root)
        const query = params.query
        if (typeof query !== 'string' || query.length > 4_096) {
          return { ok: false, error: 'search query is too long' }
        }
        if (query.length === 0) {
          return {
            ok: true,
            matches: [],
            truncated: false,
            filesScanned: 0,
            partial: false,
            errorCount: 0,
            stopReason: 'complete',
          }
        }
        const generation = (searchGenerationByOwner.get(evt.sender) ?? 0) + 1
        searchGenerationByOwner.set(evt.sender, generation)
        const cancelled = (): boolean => searchGenerationByOwner.get(evt.sender) !== generation
        const caseSensitive = params.caseSensitive === true
        const needle = caseSensitive ? query : query.toLowerCase()
        const matches: EditorFsSearchMatch[] = []
        let filesScanned = 0
        let truncated = false
        let totalBytes = 0
        let errorCount = 0
        let stopReason: EditorFsSearchStopReason = 'complete'
        // Bounds. A JS scan of a typical repo (a few thousand files after
        // the junk filter) lands well under a second; the caps are the
        // fuse for pathological roots. If real projects hit these limits
        // routinely, the follow-up is a ripgrep binary via the
        // third_party manifest pattern (#119/#120), NOT raising the caps.
        const MAX_MATCHES = 2_000
        const MAX_FILE_BYTES = 1_048_576 // >1MB = generated bundles, lockfiles
        const MAX_FILES = 20_000
        const MAX_TOTAL_BYTES = 64 * 1_048_576
        const DEADLINE_MS = 5_000
        const deadline = Date.now() + DEADLINE_MS
        const shouldStop = (): boolean => {
          if (cancelled()) {
            truncated = true
            stopReason = 'cancelled'
            return true
          }
          if (Date.now() > deadline) {
            truncated = true
            stopReason = 'deadline'
            return true
          }
          return truncated
        }
        const scanFile = async (abs: string): Promise<void> => {
          const handle = await open(abs, constants.O_RDONLY | NO_FOLLOW).catch(() => {
            errorCount += 1
            return null
          })
          if (!handle) return
          try {
            // WHY search reads through the same no-follow handle it stats:
            // using stat(path) followed by readFile(path) left a race where a
            // project entry could become a symlink between those calls and
            // make content search read outside the authorized root. The
            // directory walker already skips visible symlinks; this closes
            // the leaf swap without adding a stat syscall per result.
            const itemStat = await handle.stat()
            if (!itemStat.isFile() || itemStat.size > MAX_FILE_BYTES) return
            if (totalBytes + itemStat.size > MAX_TOTAL_BYTES) {
              truncated = true
              stopReason = 'bytes'
              return
            }
            totalBytes += itemStat.size
            const text = await handle.readFile({ encoding: 'utf8' }).catch(() => {
              errorCount += 1
              return null
            })
            // NUL byte = binary; utf8-decoding it would produce garbage
            // matches and garbage previews.
            if (text === null || text.includes('\u0000')) return
            const haystackFull = caseSensitive ? text : text.toLowerCase()
            if (!haystackFull.includes(needle)) return
            const lines = text.split('\n')
            for (let i = 0; i < lines.length; i++) {
              const hay = caseSensitive ? lines[i] : lines[i].toLowerCase()
              let col = hay.indexOf(needle)
              while (col !== -1) {
                matches.push({
                  path: toProjectPath(root, abs),
                  line: i + 1,
                  column: col + 1,
                  preview:
                    lines[i].length > 200
                      ? lines[i].slice(Math.max(0, col - 80), col + 120)
                      : lines[i],
                })
                if (matches.length >= MAX_MATCHES) {
                  truncated = true
                  stopReason = 'matches'
                  return
                }
                col = hay.indexOf(needle, col + Math.max(1, needle.length))
              }
            }
          } finally {
            await handle.close()
          }
        }
        const walk = async (dirAbs: string): Promise<void> => {
          if (shouldStop()) return
          let dirents: Dirent[]
          try {
            dirents = await readdir(dirAbs, { withFileTypes: true })
          } catch (err) {
            if (dirAbs === root) throw err
            errorCount += 1
            return
          }
          for (const dirent of dirents) {
            if (shouldStop()) return
            if (dirent.name.startsWith('.')) continue
            const abs = join(dirAbs, dirent.name)
            if (dirent.isDirectory()) {
              if (EDITOR_IGNORED_DIR_NAMES.has(dirent.name)) continue
              await walk(abs)
              continue
            }
            if (!dirent.isFile()) continue
            if (EDITOR_IGNORED_FILE_NAMES.has(dirent.name)) continue
            if (filesScanned >= MAX_FILES) {
              truncated = true
              stopReason = 'files'
              return
            }
            filesScanned += 1
            await scanFile(abs)
          }
        }
        await walk(root)
        return {
          ok: true,
          matches,
          truncated,
          filesScanned,
          partial: errorCount > 0,
          errorCount,
          stopReason,
        }
      } catch (err) {
        return { ok: false, error: errorMessage(err) }
      }
    },
  )

  ipcMain.handle(
    'editor-fs:delete',
    async (evt, params: { root: string; path: string }): Promise<EditorFsMutationResult> => {
      try {
        const root = await roots.authorize(evt.sender, params.root)
        return await serializeRootMutation(root, async () => {
          const target = resolveInsideRoot(root, params.path)
          if (toProjectPath(root, target) === '')
            return { ok: false, error: 'cannot delete project root' }
          await validateExistingTarget(root, target)
          await rm(target, { recursive: true, force: false })
          const targetPath = toProjectPath(root, target)
          editorFsCache.invalidatePath(root, targetPath)
          return { ok: true, path: targetPath || basename(target) }
        })
      } catch (err) {
        return { ok: false, error: errorMessage(err) }
      }
    },
  )
}
