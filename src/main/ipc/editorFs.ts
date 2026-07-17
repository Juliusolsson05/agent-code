import { ipcMain } from 'electron'
import {
  lstat,
  link,
  mkdir,
  opendir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'

import { EditorFsCache } from './editorFsCache.js'
import {
  atomicWriteTextFile,
  editorFileVersion,
  readBoundedTextFile,
  serializeEditorFileMutation,
} from '@main/editorFileIO.js'
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
const recursiveListGenerationByOwner = new WeakMap<object, number>()
const pendingRootMutations = new Map<string, Promise<void>>()

const MAX_TEXT_FILE_BYTES = 8 * 1_048_576
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

export async function validateExistingTarget(root: string, target: string): Promise<string> {
  const leaf = await lstat(target)
  if (leaf.isSymbolicLink()) throw new Error('symbolic links are not supported')
  const canonical = await realpath(target)
  if (!isContained(root, canonical))
    throw new Error('path escapes project root through a symbolic link')
  return canonical
}

export function invalidateEditorFsCache(root: string, path: string): void {
  editorFsCache.invalidatePath(root, path)
}

async function resolveThroughExistingParent(root: string, target: string): Promise<string> {
  const canonicalParent = await realpath(dirname(target))
  if (!isContained(root, canonicalParent)) {
    throw new Error('path escapes project root through a symbolic link')
  }
  // Return a path through the canonical parent and make callers perform the
  // actual syscall against it. Merely validating then using `target` again
  // allows an intermediate directory symlink to be swapped after validation.
  return join(canonicalParent, basename(target))
}

function sameFile(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

export async function renameWithoutClobber(from: string, to: string): Promise<void> {
  const source = await lstat(from)
  const destination = await lstat(to).catch(err => {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  })

  if (destination) {
    if (!sameFile(source, destination)) throw new Error('already exists')
    if (from === to) return

    // Case-insensitive filesystems report a case-only destination as already
    // existing because both spellings address one inode. A two-step rename is
    // required to make the requested casing observable. The sibling is
    // deliberately unique and the rollback preserves the original spelling
    // if the publish step fails.
    const temporary = join(
      dirname(from),
      `.${basename(from)}.agent-code-rename-${process.pid}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2)}.tmp`,
    )
    await rename(from, temporary)
    try {
      await rename(temporary, to)
    } catch (err) {
      await rename(temporary, from).catch(() => undefined)
      throw err
    }
    return
  }

  if (source.isFile()) {
    // link() is the portable atomic no-clobber primitive for regular files.
    // rename() would silently replace a destination created after our lstat.
    // If unlinking the old name fails, remove the new link only while both
    // names still resolve to this inode; never clean up an external writer's
    // replacement by path alone.
    await link(from, to)
    try {
      await unlink(from)
    } catch (err) {
      const [oldStat, newStat] = await Promise.all([
        lstat(from).catch(() => null),
        lstat(to).catch(() => null),
      ])
      if (oldStat && newStat && sameFile(oldStat, newStat)) {
        await unlink(to).catch(() => undefined)
      }
      throw err
    }
    return
  }

  // Node does not expose renameat2(RENAME_NOREPLACE), and hard links cannot
  // publish directories. Keep the explicit preflight above and serialize all
  // Agent Code mutations, while acknowledging that an unrelated process can
  // still create an empty destination in the final syscall window on POSIX.
  await rename(from, to)
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
        const physicalTarget = await validateExistingTarget(root, target)
        const targetPath = toProjectPath(root, target)
        const itemStat = await stat(physicalTarget)
        if (!itemStat.isDirectory()) return { ok: false, error: 'not a directory' }
        const showHidden = params.showHidden === true
        const cached = editorFsCache.getDirectory({
          root,
          path: targetPath,
          showHidden,
          mtimeMs: itemStat.mtimeMs,
          size: itemStat.size,
        })
        if (cached) {
          return {
            ok: true,
            root,
            path: targetPath,
            entries: cached,
            truncated: false,
          }
        }
        const entries: EditorFsEntry[] = []
        let truncated = false
        const directory = await opendir(physicalTarget)
        // Explorer rows are intentionally not virtualized: keyboard tree
        // semantics depend on the rendered visible order. Cap a single
        // directory before IPC/DOM growth becomes unbounded and disclose the
        // incomplete listing beside that branch.
        const MAX_DIRECTORY_ENTRIES = 2_000
        const MAX_DIRECTORY_ITEMS_VISITED = 20_000
        let itemsVisited = 0
        for await (const dirent of directory) {
          itemsVisited += 1
          if (itemsVisited > MAX_DIRECTORY_ITEMS_VISITED) {
            truncated = true
            break
          }
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
          if (entries.length >= MAX_DIRECTORY_ENTRIES) {
            truncated = true
            break
          }
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
        // A truncated directory is not cached because a later refresh should
        // get a fresh chance to observe filesystem iteration order and newly
        // added entries rather than freezing one arbitrary prefix for 30s.
        if (!truncated) {
          editorFsCache.setDirectory({
            root,
            path: targetPath,
            showHidden,
            mtimeMs: itemStat.mtimeMs,
            size: itemStat.size,
            entries,
          })
        }
        return { ok: true, root, path: targetPath, entries, truncated }
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
        const physicalTarget = await validateExistingTarget(root, target)
        const targetPath = toProjectPath(root, target)
        const observed = await lstat(physicalTarget)
        if (!observed.isFile()) return { ok: false, error: 'not a file' }
        const observedVersion = editorFileVersion(observed)
        const cached = editorFsCache.getTextFile({
          root,
          path: targetPath,
          version: observedVersion,
        })
        if (cached) return { ok: true, ...cached }
        const bounded = await readBoundedTextFile(physicalTarget, MAX_TEXT_FILE_BYTES).catch(
          err => {
            if ((err as Error).message === 'file is too large') {
              throw new Error('file is too large to open in the editor')
            }
            throw err
          },
        )
        const read = {
          path: targetPath,
          // Keep the project-relative spelling under the canonical root. An
          // intermediate symlink may resolve to a different physical suffix;
          // retaining the UI spelling while canonicalizing the root lets the
          // renderer derive a stable project boundary for safe definition
          // navigation and still lets the syscall use physicalTarget above.
          absolutePath: target,
          text: bounded.text,
          mtimeMs: bounded.stat.mtimeMs,
          size: bounded.stat.size,
          version: bounded.version,
        }
        editorFsCache.setTextFile({ root, path: targetPath, read })
        return { ok: true, ...read }
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
        expectedVersion?: string | null
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
          const physicalTarget = await resolveThroughExistingParent(root, target)
          const exists = await lstat(physicalTarget).then(
            () => true,
            err => {
              if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
              throw err
            },
          )
          if (exists) await validateExistingTarget(root, physicalTarget)
          return await serializeEditorFileMutation(physicalTarget, async () => {
            const result = await atomicWriteTextFile({
              absolutePath: physicalTarget,
              text: params.text,
              expectedVersion: params.expectedVersion,
              maxBytes: MAX_TEXT_FILE_BYTES,
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
            const targetPath = toProjectPath(root, target)
            editorFsCache.invalidatePath(root, targetPath)
            return {
              ok: true,
              path: targetPath,
              mtimeMs: result.stat.mtimeMs,
              size: result.stat.size,
              version: result.version,
            }
          })
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
          const physicalTarget = await resolveThroughExistingParent(root, target)
          await writeFile(physicalTarget, '', { encoding: 'utf8', flag: 'wx' })
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
          const physicalTarget = await resolveThroughExistingParent(root, target)
          await mkdir(physicalTarget)
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
          const physicalFrom = await validateExistingTarget(root, from)
          const physicalTo = await resolveThroughExistingParent(root, to)
          await renameWithoutClobber(physicalFrom, physicalTo)
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
        const generation = (recursiveListGenerationByOwner.get(evt.sender) ?? 0) + 1
        recursiveListGenerationByOwner.set(evt.sender, generation)
        const deadline = Date.now() + 5_000
        let directoriesVisited = 0
        // Hard cap. Quick-open ranks client-side over the whole list; 20k
        // relative paths ≈ a few MB of IPC — fine once, not fine
        // unbounded (a rogue root near / would otherwise walk the disk).
        // `truncated` lets the UI say "index incomplete" instead of
        // silently lying about coverage.
        const LIMIT = 20_000
        const stopped = (): boolean => {
          if (
            truncated ||
            recursiveListGenerationByOwner.get(evt.sender) !== generation ||
            Date.now() > deadline
          ) {
            truncated = true
            return true
          }
          return false
        }
        const walk = async (dirAbs: string): Promise<void> => {
          if (stopped()) return
          directoriesVisited += 1
          if (directoriesVisited > 20_000) {
            truncated = true
            return
          }
          let directory
          try {
            const canonicalDirectory = await validateExistingTarget(root, dirAbs)
            directory = await opendir(canonicalDirectory)
          } catch (err) {
            if (dirAbs === root) throw err
            errorCount += 1
            return
          }
          for await (const dirent of directory) {
            if (stopped()) return
            // Quick Open is the only practical way to jump directly to files
            // such as .env.example, so dotfiles stay discoverable here. The
            // heavyweight generated/vendor directory denylist remains the
            // performance boundary for recursive indexing.
            if (dirent.isDirectory()) {
              if (EDITOR_IGNORED_DIR_NAMES.has(dirent.name)) continue
              await walk(join(dirAbs, dirent.name))
              if (truncated) return
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

  ipcMain.handle('editor-fs:cancel-list-files-recursive', evt => {
    recursiveListGenerationByOwner.set(
      evt.sender,
      (recursiveListGenerationByOwner.get(evt.sender) ?? 0) + 1,
    )
  })

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
        if (query.includes('\n') || query.includes('\r')) {
          return { ok: false, error: 'multi-line search is not supported' }
        }
        const generation = (searchGenerationByOwner.get(evt.sender) ?? 0) + 1
        searchGenerationByOwner.set(evt.sender, generation)
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
        const cancelled = (): boolean => searchGenerationByOwner.get(evt.sender) !== generation
        const caseSensitive = params.caseSensitive === true
        const insensitiveMatcher = caseSensitive
          ? null
          : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
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
        // Every match becomes an interactive row. Without virtualization, 2k
        // rows can make the overlay itself the bottleneck after the bounded
        // scan completes; 500 remains useful while keeping keyboard/render
        // latency predictable.
        const MAX_MATCHES = 500
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
          try {
            // Resolve containment first, then read from a no-follow descriptor
            // with a fixed max+1 allocation. A size check followed by
            // readFile(path) is neither a memory bound nor a symlink defense:
            // an external process can grow or replace the leaf between calls.
            const physical = await validateExistingTarget(root, abs)
            const bounded = await readBoundedTextFile(physical, MAX_FILE_BYTES)
            const bytesRead = Buffer.byteLength(bounded.text, 'utf8')
            if (totalBytes + bytesRead > MAX_TOTAL_BYTES) {
              truncated = true
              stopReason = 'bytes'
              return
            }
            totalBytes += bytesRead
            const text = bounded.text
            // NUL byte = binary; utf8-decoding it would produce garbage
            // matches and garbage previews.
            if (text.includes('\u0000')) return
            const lines = text.split('\n')
            for (let i = 0; i < lines.length; i++) {
              const columns: Array<{ offset: number; length: number }> = []
              if (insensitiveMatcher) {
                insensitiveMatcher.lastIndex = 0
                for (
                  let match = insensitiveMatcher.exec(lines[i]);
                  match;
                  match = insensitiveMatcher.exec(lines[i])
                ) {
                  columns.push({ offset: match.index, length: match[0].length })
                }
              } else {
                let offset = lines[i].indexOf(query)
                while (offset !== -1) {
                  columns.push({ offset, length: query.length })
                  offset = lines[i].indexOf(query, offset + Math.max(1, query.length))
                }
              }
              for (const { offset: col, length } of columns) {
                const previewStart = lines[i].length > 200 ? Math.max(0, col - 80) : 0
                matches.push({
                  path: toProjectPath(root, abs),
                  line: i + 1,
                  column: col + 1,
                  preview: lines[i].slice(previewStart, previewStart + 200),
                  previewMatchOffset: col - previewStart,
                  previewMatchLength: length,
                })
                if (matches.length >= MAX_MATCHES) {
                  truncated = true
                  stopReason = 'matches'
                  return
                }
              }
            }
          } catch (err) {
            // Oversized regular files are an expected search exclusion, not a
            // partial-index error. Other failures matter because the footer
            // must disclose that some authorized paths could not be scanned.
            if ((err as Error).message !== 'file is too large') errorCount += 1
          }
        }
        const walk = async (dirAbs: string): Promise<void> => {
          if (shouldStop()) return
          let directory
          try {
            const physical = await validateExistingTarget(root, dirAbs)
            directory = await opendir(physical)
          } catch (err) {
            if (dirAbs === root) throw err
            errorCount += 1
            return
          }
          for await (const dirent of directory) {
            if (shouldStop()) return
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
          const physicalTarget = await validateExistingTarget(root, target)
          await rm(physicalTarget, { recursive: true, force: false })
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
