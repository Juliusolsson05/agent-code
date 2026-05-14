import { ipcMain } from 'electron'
import { homedir } from 'os'
import { join, resolve } from 'path'
import { mkdir, readdir, stat } from 'fs/promises'

import { saveClaudeImage } from '@main/storage/claudeImageCache.js'

// Filesystem-level IPC — path expansion, directory listing, Claude
// image paste cache.
//
// fs:listDirectory + fs:expandCwd both ship `~` / `~/…` expansion in
// the same shape; we deliberately don't expand `~user` (needs passwd
// lookup, nobody uses it in practice). Both return a discriminated
// union so callers can show errors inline without throwing.

export function registerFsIpc(): void {
  // Directory listing for PathInput completion. Returns entries as
  // { name, isDirectory } for the renderer to filter + display as a
  // suggestion dropdown.
  //
  // Options:
  //   directoriesOnly — filter out regular files (default true for
  //                     cwd pickers, false for file pickers)
  //   showHidden      — include .dotfile entries (default false)
  type DirEntry = { name: string; isDirectory: boolean; path: string }
  type ListResult =
    | { ok: true; entries: DirEntry[]; expanded: string }
    | { ok: false; error: string }

  ipcMain.handle(
    'fs:listDirectory',
    async (
      _evt,
      rawPath: string,
      opts?: { directoriesOnly?: boolean; showHidden?: boolean },
    ): Promise<ListResult> => {
      const directoriesOnly = opts?.directoriesOnly ?? true
      const showHidden = opts?.showHidden ?? false

      // Empty / `.` / `~` all mean "home directory" — the natural
      // starting point for path completion in a picker.
      let expanded = rawPath.trim()
      if (expanded === '' || expanded === '~') {
        expanded = homedir()
      } else if (expanded.startsWith('~/')) {
        expanded = join(homedir(), expanded.slice(2))
      }
      expanded = resolve(expanded)

      try {
        const dirents = await readdir(expanded, { withFileTypes: true })
        const entries: DirEntry[] = []
        for (const d of dirents) {
          if (!showHidden && d.name.startsWith('.')) continue
          const isDirectory = d.isDirectory()
          if (directoriesOnly && !isDirectory) continue
          entries.push({
            name: d.name,
            isDirectory,
            path: join(expanded, d.name),
          })
        }
        // Directories first, then alpha (case-insensitive). Matches
        // the Finder / VS Code / Sublime convention.
        entries.sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
          return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        })
        return { ok: true, entries, expanded }
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (e.code === 'ENOENT') return { ok: false, error: 'does not exist' }
        if (e.code === 'ENOTDIR') return { ok: false, error: 'not a directory' }
        if (e.code === 'EACCES') return { ok: false, error: 'permission denied' }
        return { ok: false, error: e.message ?? 'read failed' }
      }
    },
  )

  ipcMain.handle(
    'fs:saveClaudeImage',
    async (
      _evt,
      params: { base64Data: string; mediaType: string; filename?: string },
    ) => {
      return await saveClaudeImage(params)
    },
  )

  // Path expansion + validation. Replaces the native folder picker —
  // the renderer shows a text input modal where the user types a
  // path; we expand `~`, resolve to an absolute path, and check that
  // it exists and is a directory. Keyboard-first is faster for power
  // users and matches Agent Code's terminal-native vibe.
  ipcMain.handle(
    'fs:expandCwd',
    async (
      _evt,
      raw: string,
    ): Promise<
      | { ok: true; path: string }
      // resolvedPath rides on the error variant so the picker can show a
      // "Will create: <abs>" hint when the user is about to commit a
      // create-and-open. The path expansion succeeded — only the on-disk
      // existence check failed — so the absolute path is well-defined and
      // safe to surface. Adding the field as optional keeps every existing
      // caller (which only branches on `ok` vs `error`) backward compatible.
      | { ok: false; error: string; resolvedPath?: string }
    > => {
      const trimmed = raw.trim()
      if (!trimmed) return { ok: false, error: 'path is empty' }
      let expanded: string
      if (trimmed === '~') {
        expanded = homedir()
      } else if (trimmed.startsWith('~/')) {
        expanded = join(homedir(), trimmed.slice(2))
      } else {
        expanded = trimmed
      }
      const abs = resolve(expanded)
      try {
        const s = await stat(abs)
        if (!s.isDirectory()) {
          return { ok: false, error: 'not a directory', resolvedPath: abs }
        }
        return { ok: true, path: abs }
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (e.code === 'ENOENT') return { ok: false, error: 'does not exist', resolvedPath: abs }
        if (e.code === 'EACCES') return { ok: false, error: 'permission denied', resolvedPath: abs }
        return { ok: false, error: e.message ?? 'stat failed', resolvedPath: abs }
      }
    },
  )

  // Create a directory the user just typed into the path picker.
  //
  // WHY this is a peer of fs:expandCwd instead of a flag on it:
  //   `expandCwd` is the validation gate the rest of the new-tab flow
  //   has always depended on — it returns a discriminated "ok | error"
  //   shape and the caller uses that exact result to gate session
  //   spawning. Folding `mkdir` into `expandCwd` would silently change
  //   that gate's semantics (every call would suddenly have the side
  //   effect of creating missing paths) and turn an idempotent
  //   read-only IPC into a write. Keeping the create step explicit and
  //   caller-driven means PathPickerModal still re-validates the path
  //   through `expandCwd` after creation, so session spawning never
  //   feeds an "as typed" string into the spawn path.
  //
  // WHY mkdir is recursive:
  //   The user-facing affordance is "type a path that doesn't exist
  //   yet, hit Create & Open". That phrasing applies whether one or
  //   five segments are missing. mkdir { recursive: true } makes both
  //   cases work identically and matches what a developer at a shell
  //   prompt would do (`mkdir -p`). The picker shows the resolved
  //   absolute path in a hint line before the user commits, so a typo
  //   deep in the path is visible before it materialises on disk.
  //
  // WHY EEXIST is treated as the "path exists but is not a directory"
  // error and not as success:
  //   A successful `mkdir -p` against an already-existing directory
  //   does not throw at all (recursive: true is idempotent on dirs).
  //   The only way to land in the EEXIST branch is if the existing
  //   entry is a file or symlink to a non-directory — which is what
  //   the user-facing error should say.
  ipcMain.handle(
    'fs:createDirectory',
    async (
      _evt,
      raw: string,
    ): Promise<{ ok: true; path: string } | { ok: false; error: string }> => {
      const trimmed = raw.trim()
      if (!trimmed) return { ok: false, error: 'path is empty' }
      let expanded: string
      if (trimmed === '~') {
        expanded = homedir()
      } else if (trimmed.startsWith('~/')) {
        expanded = join(homedir(), trimmed.slice(2))
      } else {
        expanded = trimmed
      }
      const abs = resolve(expanded)
      try {
        await mkdir(abs, { recursive: true })
        return { ok: true, path: abs }
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        if (e.code === 'EACCES' || e.code === 'EPERM') {
          return { ok: false, error: 'permission denied' }
        }
        if (e.code === 'EEXIST' || e.code === 'ENOTDIR') {
          return { ok: false, error: 'path exists but is not a directory' }
        }
        if (e.code === 'EROFS') return { ok: false, error: 'filesystem is read-only' }
        return { ok: false, error: e.message ?? 'mkdir failed' }
      }
    },
  )
}
