import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'fs/promises'

import { STATE_DIR, STATE_FILE } from '@main/storage/paths.js'
import {
  collectSessionIds,
  emptyWorkspaceFile,
  parseWorkspaceFile,
  readWindowWorkspaceJson,
  serializeWorkspaceFile,
  withoutWindow,
  withWindowSlice,
} from '@main/storage/workspaceFile.js'
import type {
  PersistedWindow,
  WindowBounds,
  WorkspaceFile,
} from '@main/storage/workspaceFile.js'

// The single writer of `~/.config/agent-code/workspace.json`.
//
// WHY this is a stateful store rather than the stateless byte mover it
// replaced: with several windows the file is composed from N authors, so the
// process has to hold the composed document between saves. It also has to be
// read BEFORE any window exists — startup needs the window list to know how
// many windows to create — which the old renderer-driven `workspace:load`
// could not provide.
//
// Everything about the durability discipline is inherited from the old handler
// and the reasoning is kept verbatim below, because it was earned: unique temp
// names, one admission-ordered tail for reads and writes both, and cleanup that
// never scans for sibling temp files.

export type WindowGeometry = {
  bounds: WindowBounds | null
  displayId: number | null
  fullScreen: boolean
}

export class WorkspaceFileStore {
  private file: WorkspaceFile = emptyWorkspaceFile()

  /**
   * Set when the file on disk exists but this build cannot represent it.
   *
   * WHY a refusal flag rather than "start fresh": overwriting a
   * newer-or-corrupt workspace.json destroys the only copy of the user's tabs,
   * agents, and pins. Running with an empty in-memory workspace while refusing
   * to write means a downgrade or a truncated file costs a session, not the
   * workspace. Autosave surfaces the rejection through its existing retry/warn
   * path, so the user is not silently working in a workspace that cannot save.
   */
  private readOnlyReason: string | null = null

  // WHY the whole save transaction is queued, not just writeFile: unique temp
  // names prevent scratch-path ENOENT races, but they do not order the final
  // renames. An older renderer save can be delayed, rename after a newer save,
  // and then acknowledge an ownership map that is no longer the newest one.
  // Keeping write + rename + acknowledgement on one admission-ordered tail
  // makes the bytes on disk and SessionManager's ownership commit one atomic
  // logical sequence. A rejected save is still surfaced to its IPC caller;
  // only the private tail absorbs it so later saves are not poisoned forever.
  private saveTail: Promise<void> = Promise.resolve()

  static async open(): Promise<WorkspaceFileStore> {
    const store = new WorkspaceFileStore()
    await store.load()
    return store
  }

  private async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(STATE_FILE, 'utf8')
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code === 'ENOENT') return // fresh install, no state yet
      // A read error that is not "missing" (permissions, EIO) is the same class
      // of unknown as an unparseable file: do not write over what we could not
      // read.
      this.readOnlyReason = `workspace.json could not be read: ${e.message}`
      return
    }

    const parsed = parseWorkspaceFile(text, () => randomUUID())
    if (parsed.kind === 'unreadable') {
      this.readOnlyReason = parsed.reason
      // eslint-disable-next-line no-console
      console.error('[workspace] refusing to write:', parsed.reason)
      return
    }
    this.file = parsed.file
    if (parsed.migratedFromV1) {
      // eslint-disable-next-line no-console
      console.info('[workspace] migrated single-window workspace.json to the window format')
    }
  }

  /** The windows to restore at startup, in file order. */
  windows(): readonly PersistedWindow[] {
    return this.file.windows
  }

  isReadOnly(): boolean {
    return this.readOnlyReason !== null
  }

  /** Union of every window's committed session ids. */
  sessionIds(): Set<string> {
    return collectSessionIds(this.file)
  }

  /**
   * The `{ workspace }` payload for one window, or null when that window has
   * nothing persisted (a brand-new window, or a fresh install).
   *
   * WHY reads join the same tail even though they do not mutate the file: an
   * unload save can be admitted before the replacement renderer asks to load
   * but still be blocked before rename. Reading around that admitted save
   * lets the new renderer reclaim old predecessor bytes just before the old
   * renderer durably writes/acknowledges the now-killed successor. Atomic
   * rename prevents corrupt bytes; this ordering prevents a valid-but-stale
   * ownership snapshot. saveTail absorbs failures, so a rejected save delays
   * the read until settlement without changing the error shape.
   */
  async loadSlice(windowId: string): Promise<string | null> {
    await this.saveTail
    return readWindowWorkspaceJson(this.file, windowId)
  }

  /** Replace one window's slice. Every other window's slice is untouched. */
  saveSlice(windowId: string, json: string, geometry: WindowGeometry): Promise<void> {
    if (this.readOnlyReason) {
      return Promise.reject(new Error(this.readOnlyReason))
    }

    let workspace: unknown
    try {
      const payload: unknown = JSON.parse(json)
      workspace = typeof payload === 'object' && payload !== null
        ? (payload as { workspace?: unknown }).workspace
        : undefined
    } catch {
      workspace = undefined
    }
    if (typeof workspace !== 'object' || workspace === null) {
      // WHY a malformed payload is now rejected where it used to be written:
      // opaque bytes could be stored verbatim, but a window SLICE cannot — the
      // blob has to be placed inside a document that other windows share. There
      // is no way to store unparseable bytes in one slot without risking the
      // whole file, and silently dropping the save would let a window believe
      // it is durable when it is not.
      return Promise.reject(new Error('workspace:save payload is not a { workspace } object'))
    }

    const next = withWindowSlice(this.file, windowId, workspace, geometry)
    return this.commit(next)
  }

  /**
   * Persist geometry alone, without touching the window's workspace payload.
   *
   * WHY this exists separately from `saveSlice`: moving a window changes
   * nothing the renderer knows about, so it produces no autosave and would
   * otherwise only reach disk if the user happened to touch a pane before
   * quitting. A window that has never saved a workspace is skipped rather than
   * created — there is nothing to restore for it yet, and inventing a record
   * with no workspace would produce an empty window on the next launch.
   */
  updateGeometry(windowId: string, geometry: WindowGeometry): Promise<void> {
    if (this.readOnlyReason) return Promise.resolve()
    const existing = this.file.windows.find(entry => entry.windowId === windowId)
    if (!existing) return Promise.resolve()
    return this.commit(withWindowSlice(this.file, windowId, existing.workspace, geometry))
  }

  /** Drop a window's slice — used when a closing window's workspace has been
   *  handed to a survivor and must not also be restored on next launch. */
  removeWindow(windowId: string): Promise<void> {
    if (this.readOnlyReason) return Promise.resolve()
    return this.commit(withoutWindow(this.file, windowId))
  }

  private commit(next: WorkspaceFile): Promise<void> {
    const save = this.saveTail.then(async () => {
      await mkdir(STATE_DIR, { recursive: true })
      // WHY this temp file is still unique even though saves are serialized:
      // the queue is process-local ordering, while the nonce is crash-safety
      // and protection from stale scratch files left by an interrupted run.
      // The final destination remains one atomic rename target.
      const tmp = `${STATE_FILE}.${process.pid}.${Date.now()}.${Math.random()
        .toString(36)
        .slice(2)}.tmp`
      try {
        await writeFile(tmp, serializeWorkspaceFile(next), 'utf8')
        await rename(tmp, STATE_FILE)
      } catch (error) {
        // WHY cleanup is scoped to this exact nonce path: a rename failure can
        // leave a complete scratch file behind, and durability retry creates a
        // new nonce on every attempt. Without unlink, a persistent destination
        // error converts eventual-success retry into unbounded disk/inode use.
        // Never scan the directory or infer sibling names—another admitted
        // save may own them. Cleanup remains best-effort so the caller receives
        // the original write/rename failure that explains why commit did not
        // happen.
        try {
          await unlink(tmp)
        } catch {
          // Missing/locked scratch cleanup cannot make the failed save durable.
        }
        throw error
      }
      // The in-memory document only advances once the bytes are durable. If the
      // write failed, the next save must still be composed against the last
      // state that actually reached disk, or a retry would silently commit a
      // window slice that was never persisted alongside it.
      this.file = next
    })
    this.saveTail = save.catch(() => undefined)
    return save
  }
}
