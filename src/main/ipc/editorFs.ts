import { ipcMain } from 'electron'
import { constants } from 'fs'
import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { basename, dirname, join, relative, resolve } from 'path'

import { EditorFsCache } from './editorFsCache'

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

type EditorFsEntry = {
  name: string
  path: string
  isDirectory: boolean
  size: number | null
  mtimeMs: number
}

type EditorFsListResult =
  | { ok: true; root: string; path: string; entries: EditorFsEntry[] }
  | { ok: false; error: string }

type EditorFsReadResult =
  | { ok: true; path: string; text: string; mtimeMs: number; size: number }
  | { ok: false; error: string }

type EditorFsWriteResult =
  | { ok: true; path: string; mtimeMs: number; size: number }
  | { ok: false; error: string; conflict?: boolean }

type EditorFsMutationResult =
  | { ok: true; path: string }
  | { ok: false; error: string }

function errorMessage(err: unknown): string {
  const e = err as NodeJS.ErrnoException
  if (e.code === 'ENOENT') return 'does not exist'
  if (e.code === 'ENOTDIR') return 'not a directory'
  if (e.code === 'EISDIR') return 'is a directory'
  if (e.code === 'EACCES' || e.code === 'EPERM') return 'permission denied'
  return e.message ?? 'filesystem operation failed'
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+/, '')
}

function resolveInsideRoot(root: string, path = ''): string {
  const rootAbs = resolve(root)
  const target = resolve(rootAbs, normalizeRelativePath(path))
  const rel = relative(rootAbs, target)
  // WHY this guard lives in main, not the renderer: every future editor
  // surface will eventually take user-controlled paths from clicks, fuzzy
  // search, rename dialogs, drag/drop, or extension-like automation. The
  // renderer is not the trust boundary. Keeping the containment check beside
  // the actual filesystem call means a UI bug can at worst ask for a bad path;
  // it cannot escape the project root and read or overwrite arbitrary files.
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || resolve(rel) === rel) {
    throw new Error('path escapes project root')
  }
  return target
}

function toProjectPath(root: string, abs: string): string {
  const rel = relative(resolve(root), abs).replace(/\\/g, '/')
  return rel === '' ? '' : rel
}

const editorFsCache = new EditorFsCache()

export function registerEditorFsIpc(): void {
  ipcMain.handle(
    'editor-fs:list-directory',
    async (_evt, params: { root: string; path?: string; showHidden?: boolean }): Promise<EditorFsListResult> => {
      try {
        const root = resolve(params.root)
        const target = resolveInsideRoot(root, params.path ?? '')
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
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
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
    async (_evt, params: { root: string; path: string }): Promise<EditorFsReadResult> => {
      try {
        const root = resolve(params.root)
        const target = resolveInsideRoot(root, params.path)
        const itemStat = await stat(target)
        if (!itemStat.isFile()) return { ok: false, error: 'not a file' }
        const targetPath = toProjectPath(root, target)
        const cached = editorFsCache.getTextFile({
          root,
          path: targetPath,
          mtimeMs: itemStat.mtimeMs,
          size: itemStat.size,
        })
        if (cached) return { ok: true, ...cached }
        const text = await readFile(target, 'utf8')
        const read = {
          path: targetPath,
          text,
          mtimeMs: itemStat.mtimeMs,
          size: itemStat.size,
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
      _evt,
      params: { root: string; path: string; text: string; expectedMtimeMs?: number | null },
    ): Promise<EditorFsWriteResult> => {
      try {
        const root = resolve(params.root)
        const target = resolveInsideRoot(root, params.path)
        const before = await stat(target).catch(() => null)
        if (before && !before.isFile()) return { ok: false, error: 'not a file' }
        if (
          before &&
          typeof params.expectedMtimeMs === 'number' &&
          Math.abs(before.mtimeMs - params.expectedMtimeMs) > 1
        ) {
          // WHY conflict detection is optimistic instead of locking: cc-shell is
          // a companion editor, not the system editor of record. Agents, git
          // commands, package managers, and external IDEs may all touch the same
          // files while the buffer is open. A cheap mtime check catches the
          // common "agent changed this after I opened it" case without keeping
          // file handles locked or inventing a heavyweight document service.
          return { ok: false, error: 'file changed on disk', conflict: true }
        }
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, params.text, 'utf8')
        const after = await stat(target)
        const targetPath = toProjectPath(root, target)
        editorFsCache.invalidatePath(root, targetPath)
        return {
          ok: true,
          path: targetPath,
          mtimeMs: after.mtimeMs,
          size: after.size,
        }
      } catch (err) {
        return { ok: false, error: errorMessage(err) }
      }
    },
  )

  ipcMain.handle(
    'editor-fs:create-file',
    async (_evt, params: { root: string; path: string }): Promise<EditorFsMutationResult> => {
      try {
        const root = resolve(params.root)
        const target = resolveInsideRoot(root, params.path)
        await mkdir(dirname(target), { recursive: true })
        await access(target, constants.F_OK).then(
          () => {
            throw new Error('already exists')
          },
          () => undefined,
        )
        await writeFile(target, '', 'utf8')
        const targetPath = toProjectPath(root, target)
        editorFsCache.invalidatePath(root, targetPath)
        return { ok: true, path: targetPath }
      } catch (err) {
        return { ok: false, error: errorMessage(err) }
      }
    },
  )

  ipcMain.handle(
    'editor-fs:create-directory',
    async (_evt, params: { root: string; path: string }): Promise<EditorFsMutationResult> => {
      try {
        const root = resolve(params.root)
        const target = resolveInsideRoot(root, params.path)
        await mkdir(target, { recursive: true })
        const targetPath = toProjectPath(root, target)
        editorFsCache.invalidatePath(root, targetPath)
        return { ok: true, path: targetPath }
      } catch (err) {
        return { ok: false, error: errorMessage(err) }
      }
    },
  )

  ipcMain.handle(
    'editor-fs:rename',
    async (_evt, params: { root: string; fromPath: string; toPath: string }): Promise<EditorFsMutationResult> => {
      try {
        const root = resolve(params.root)
        const from = resolveInsideRoot(root, params.fromPath)
        const to = resolveInsideRoot(root, params.toPath)
        await mkdir(dirname(to), { recursive: true })
        await rename(from, to)
        const fromPath = toProjectPath(root, from)
        const toPath = toProjectPath(root, to)
        editorFsCache.invalidatePath(root, fromPath)
        editorFsCache.invalidatePath(root, toPath)
        return { ok: true, path: toPath }
      } catch (err) {
        return { ok: false, error: errorMessage(err) }
      }
    },
  )

  ipcMain.handle(
    'editor-fs:delete',
    async (_evt, params: { root: string; path: string }): Promise<EditorFsMutationResult> => {
      try {
        const root = resolve(params.root)
        const target = resolveInsideRoot(root, params.path)
        if (toProjectPath(root, target) === '') return { ok: false, error: 'cannot delete project root' }
        await rm(target, { recursive: true, force: false })
        const targetPath = toProjectPath(root, target)
        editorFsCache.invalidatePath(root, targetPath)
        return { ok: true, path: targetPath || basename(target) }
      } catch (err) {
        return { ok: false, error: errorMessage(err) }
      }
    },
  )
}
