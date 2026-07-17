import { ipcMain, type WebContents } from 'electron'
import { watch, type FSWatcher } from 'chokidar'
import { lstat } from 'fs/promises'

import { invalidateEditorFsCache, resolveInsideRoot, validateExistingTarget } from './editorFs.js'
import type { EditorFsRootRegistry } from './editorFsRootRegistry.js'
import type { EditorFsChangeEvent, EditorFsDirectoryChangeEvent } from '@shared/types/editorFs.js'

type Owner = {
  sender: WebContents
  root: string
  canonicalRoot: string
  path: string
}

type WatchEntry = {
  watcher: FSWatcher
  owners: Map<string, Owner>
  ready: Promise<void>
  finishReady: (error?: Error) => void
}

const watchers = new Map<string, WatchEntry>()
const directoryWatchers = new Map<string, WatchEntry>()
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

function sendToDirectoryOwners(entry: WatchEntry, error?: string): void {
  for (const owner of entry.owners.values()) {
    if (owner.sender.isDestroyed()) continue
    invalidateEditorFsCache(owner.canonicalRoot, owner.path)
    owner.sender.send('editor-fs:directory-changed', {
      root: owner.root,
      path: owner.path,
      ...(error ? { error } : {}),
    } satisfies EditorFsDirectoryChangeEvent)
  }
}

function subscriptionKey(ownerId: number, canonicalRoot: string, path: string): string {
  return `${ownerId}\0${canonicalRoot}\0${path.replace(/\\/g, '/')}`
}

async function removeOwner(ownerId: number): Promise<void> {
  const closes: Promise<void>[] = []
  for (const [key, entry] of watchers) {
    for (const [subscription, owner] of entry.owners) {
      if (owner.sender.id === ownerId) entry.owners.delete(subscription)
    }
    if (entry.owners.size === 0) {
      watchers.delete(key)
      entry.finishReady(new Error('file watch was cancelled before it became ready'))
      closes.push(entry.watcher.close())
    }
  }
  for (const [key, entry] of directoryWatchers) {
    for (const [subscription, owner] of entry.owners) {
      if (owner.sender.id === ownerId) entry.owners.delete(subscription)
    }
    if (entry.owners.size === 0) {
      directoryWatchers.delete(key)
      entry.finishReady(new Error('directory watch was cancelled before it became ready'))
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
    const requested = resolveInsideRoot(canonicalRoot, params.path)
    const key = await validateExistingTarget(canonicalRoot, requested)
    trackOwner(evt.sender)

    const normalizedPath = params.path.replace(/\\/g, '/')

    const owner: Owner = {
      sender: evt.sender,
      root: params.root,
      canonicalRoot,
      path: normalizedPath,
    }
    const ownerKey = subscriptionKey(evt.sender.id, canonicalRoot, normalizedPath)
    const existing = watchers.get(key)
    if (existing) {
      // Idempotent per owner: React retries/reconciliation must not create a
      // refcount that requires the renderer to remember how many times it
      // happened to invoke watch.
      existing.owners.set(ownerKey, owner)
      await existing.ready
      return
    }

    const watcher = watch(key, {
      ignoreInitial: true,
      followSymlinks: false,
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
    })
    let resolveReady!: () => void
    let rejectReady!: (error: Error) => void
    let readySettled = false
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const finishReady = (error?: Error): void => {
      if (readySettled) return
      readySettled = true
      if (error) rejectReady(error)
      else resolveReady()
    }
    const entry: WatchEntry = {
      watcher,
      owners: new Map([[ownerKey, owner]]),
      ready,
      finishReady,
    }
    const emitChanged = (): void => {
      void lstat(key)
        .then(value => {
          if (value.isSymbolicLink() || !value.isFile()) {
            sendToOwners(entry, {
              kind: 'error',
              mtimeMs: null,
              error: 'watched path is no longer a regular file',
            })
            return
          }
          sendToOwners(entry, { kind: 'change', mtimeMs: value.mtimeMs })
        })
        .catch(() => sendToOwners(entry, { kind: 'change', mtimeMs: null }))
    }
    watcher.on('change', emitChanged)
    watcher.on('add', emitChanged)
    watcher.on('unlink', () => {
      sendToOwners(entry, { kind: 'unlink', mtimeMs: null })
    })
    watcher.on('error', error => {
      finishReady(error instanceof Error ? error : new Error('file watcher failed'))
      sendToOwners(entry, {
        kind: 'error',
        mtimeMs: null,
        error: error instanceof Error ? error.message : 'file watcher failed',
      })
    })
    watcher.once('ready', () => finishReady())
    watchers.set(key, entry)
    // Renderer registration is not complete until Chokidar has installed its
    // native subscriptions. A resolved watch followed by an immediate save used
    // to create a blind initial-read→watch-ready window.
    await ready
  })

  ipcMain.handle('editor-fs:unwatch', async (evt, params: { root: string; path: string }) => {
    const canonicalRoot = await roots.authorize(evt.sender, params.root)
    // Unwatch is a capability revocation, not a fresh filesystem access. Find
    // the exact subscription identity we registered instead of re-resolving a
    // path that may now be deleted, replaced by a symlink, or reachable through
    // an alias whose physical spelling no longer exists.
    const ownerKey = subscriptionKey(evt.sender.id, canonicalRoot, params.path)
    for (const [key, entry] of watchers) {
      if (!entry.owners.delete(ownerKey)) continue
      if (entry.owners.size === 0) {
        watchers.delete(key)
        entry.finishReady(new Error('file watch was cancelled before it became ready'))
        await entry.watcher.close()
      }
      return
    }
  })

  ipcMain.handle(
    'editor-fs:watch-directory',
    async (evt, params: { root: string; path: string }) => {
      const canonicalRoot = await roots.authorize(evt.sender, params.root)
      const requested = resolveInsideRoot(canonicalRoot, params.path)
      const key = await validateExistingTarget(canonicalRoot, requested)
      const value = await lstat(key)
      if (!value.isDirectory()) throw new Error('not a directory')
      trackOwner(evt.sender)

      const normalizedPath = params.path.replace(/\\/g, '/')
      const owner: Owner = {
        sender: evt.sender,
        root: params.root,
        canonicalRoot,
        path: normalizedPath,
      }
      const ownerKey = subscriptionKey(evt.sender.id, canonicalRoot, normalizedPath)
      const existing = directoryWatchers.get(key)
      if (existing) {
        existing.owners.set(ownerKey, owner)
        await existing.ready
        return
      }

      // Watch only immediate membership of EXPANDED directories. A recursive
      // root watcher would crawl node_modules/build trees the Explorer itself
      // deliberately keeps closed; depth zero scales with what the user can
      // actually see and expanded children register their own subscriptions.
      const watcher = watch(key, {
        ignoreInitial: true,
        followSymlinks: false,
        depth: 0,
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
      })
      let resolveReady!: () => void
      let rejectReady!: (error: Error) => void
      let readySettled = false
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      })
      const finishReady = (error?: Error): void => {
        if (readySettled) return
        readySettled = true
        if (error) rejectReady(error)
        else resolveReady()
      }
      const entry: WatchEntry = {
        watcher,
        owners: new Map([[ownerKey, owner]]),
        ready,
        finishReady,
      }
      const changed = () => sendToDirectoryOwners(entry)
      watcher.on('add', changed)
      watcher.on('unlink', changed)
      watcher.on('addDir', changed)
      watcher.on('unlinkDir', changed)
      watcher.on('error', error => {
        const failure = error instanceof Error ? error : new Error('directory watch failed')
        finishReady(failure)
        // A post-ready native watcher error is terminal for freshness. Leaving
        // the dead entry cached makes future registrations appear successful
        // while Explorer remains silently stale, so notify every owner and
        // remove it before allowing a later collapse/re-expand to retry.
        sendToDirectoryOwners(entry, failure.message)
        if (directoryWatchers.get(key) === entry) directoryWatchers.delete(key)
        void watcher.close()
      })
      watcher.once('ready', () => finishReady())
      directoryWatchers.set(key, entry)
      await ready
    },
  )

  ipcMain.handle(
    'editor-fs:unwatch-directory',
    async (evt, params: { root: string; path: string }) => {
      const canonicalRoot = await roots.authorize(evt.sender, params.root)
      const ownerKey = subscriptionKey(evt.sender.id, canonicalRoot, params.path)
      for (const [key, entry] of directoryWatchers) {
        if (!entry.owners.delete(ownerKey)) continue
        if (entry.owners.size === 0) {
          directoryWatchers.delete(key)
          entry.finishReady(new Error('directory watch was cancelled before it became ready'))
          await entry.watcher.close()
        }
        return
      }
    },
  )
}
