import { ipcMain, type WebContents } from 'electron'
import { watch, type FSWatcher } from 'chokidar'
import { stat } from 'fs/promises'

import { invalidateEditorFsCache, resolveInsideRoot, validateExistingTarget } from './editorFs.js'
import type { EditorFsRootRegistry } from './editorFsRootRegistry.js'
import type { EditorFsChangeEvent } from '@shared/types/editorFs.js'

type Owner = {
  sender: WebContents
  root: string
  canonicalRoot: string
  path: string
}

type WatchEntry = {
  watcher: FSWatcher
  owners: Map<number, Owner>
}

const watchers = new Map<string, WatchEntry>()
const trackedOwners = new WeakSet<WebContents>()

function sendToOwners(entry: WatchEntry, event: Omit<EditorFsChangeEvent, 'root' | 'path'>): void {
  for (const owner of entry.owners.values()) {
    if (owner.sender.isDestroyed()) continue
    invalidateEditorFsCache(owner.canonicalRoot, owner.path)
    owner.sender.send('editor-fs:file-changed', {
      ...event,
      root: owner.root,
      path: owner.path,
    } satisfies EditorFsChangeEvent)
  }
  // The physical key is intentionally not included in renderer events. Each
  // owner receives the root/path identity it registered, so nested roots and
  // aliases can compare against their own store without leaking another
  // window's project identity.
}

async function removeOwner(ownerId: number): Promise<void> {
  const closes: Promise<void>[] = []
  for (const [key, entry] of watchers) {
    entry.owners.delete(ownerId)
    if (entry.owners.size === 0) {
      watchers.delete(key)
      closes.push(entry.watcher.close())
    }
  }
  await Promise.allSettled(closes)
}

function trackOwner(sender: WebContents): void {
  if (trackedOwners.has(sender)) return
  trackedOwners.add(sender)
  const clear = (): void => {
    void removeOwner(sender.id)
  }
  sender.once('destroyed', clear)
  sender.on('did-start-navigation', details => {
    if (details.isMainFrame && !details.isSameDocument) clear()
  })
  sender.on('render-process-gone', clear)
}

export function registerEditorFsWatchIpc(roots: EditorFsRootRegistry): void {
  ipcMain.handle('editor-fs:watch', async (evt, params: { root: string; path: string }) => {
    const canonicalRoot = await roots.authorize(evt.sender, params.root)
    const key = resolveInsideRoot(canonicalRoot, params.path)
    await validateExistingTarget(canonicalRoot, key)
    trackOwner(evt.sender)

    const owner: Owner = {
      sender: evt.sender,
      root: params.root,
      canonicalRoot,
      path: params.path,
    }
    const existing = watchers.get(key)
    if (existing) {
      // Idempotent per owner: React retries/reconciliation must not create a
      // refcount that requires the renderer to remember how many times it
      // happened to invoke watch.
      existing.owners.set(evt.sender.id, owner)
      return
    }

    const watcher = watch(key, {
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
    })
    const entry: WatchEntry = {
      watcher,
      owners: new Map([[evt.sender.id, owner]]),
    }
    const emitChanged = (): void => {
      void stat(key)
        .then(value =>
          sendToOwners(entry, {
            kind: 'change',
            mtimeMs: value.mtimeMs,
          }),
        )
        .catch(() => sendToOwners(entry, { kind: 'change', mtimeMs: null }))
    }
    watcher.on('change', emitChanged)
    watcher.on('add', emitChanged)
    watcher.on('unlink', () => {
      sendToOwners(entry, { kind: 'unlink', mtimeMs: null })
    })
    watcher.on('error', error => {
      sendToOwners(entry, {
        kind: 'error',
        mtimeMs: null,
        error: error instanceof Error ? error.message : 'file watcher failed',
      })
    })
    watchers.set(key, entry)
  })

  ipcMain.handle('editor-fs:unwatch', async (evt, params: { root: string; path: string }) => {
    const canonicalRoot = await roots.authorize(evt.sender, params.root)
    const key = resolveInsideRoot(canonicalRoot, params.path)
    const entry = watchers.get(key)
    if (!entry) return
    entry.owners.delete(evt.sender.id)
    if (entry.owners.size === 0) {
      watchers.delete(key)
      await entry.watcher.close()
    }
  })
}
