import { ipcMain, type WebContents } from 'electron'
import { watch, type FSWatcher } from 'chokidar'
import { stat } from 'fs/promises'

import { resolveInsideRoot } from './editorFs.js'
import type { EditorFsChangeEvent } from '@shared/types/editorFs.js'

// Per-file watchers for open editor buffers (#513).
//
// WHY individual file watchers, not one recursive root watcher: the roots
// here are entire project checkouts (node_modules included). A recursive
// watcher on a big repo costs thousands of kernel watch descriptors and a
// storm of events the editor doesn't care about; the editor only needs to
// know about files it actually has open — a handful. Watch registration
// follows buffer lifetime, driven by the renderer (GlobalEditorShell
// keeps the watched set aligned with the active cwd's open tabs).
//
// WHY refcounted: two surfaces (Global Editor per-cwd buffers now,
// possibly split views later) may watch the same file; the second unwatch
// must not kill the first watcher.
//
// WHY broadcast to subscriber WebContents instead of replying per-invoke:
// changes arrive long after the watch call returns; push is the only
// shape that fits. The subscriber set self-prunes on 'destroyed' so a
// closed window doesn't accumulate dead senders.

type WatchEntry = { watcher: FSWatcher; refs: number }
const watchers = new Map<string, WatchEntry>() // key: contained absolute path
const subscribers = new Set<WebContents>()

function broadcast(event: EditorFsChangeEvent): void {
  for (const wc of subscribers) {
    if (!wc.isDestroyed()) wc.send('editor-fs:file-changed', event)
  }
}

export function registerEditorFsWatchIpc(): void {
  ipcMain.handle(
    'editor-fs:watch',
    async (evt, params: { root: string; path: string }) => {
      subscribers.add(evt.sender)
      evt.sender.once('destroyed', () => subscribers.delete(evt.sender))
      // Containment before anything touches the filesystem — same
      // invariant as every other editor-fs handler.
      const key = resolveInsideRoot(params.root, params.path)
      const existing = watchers.get(key)
      if (existing) {
        existing.refs += 1
        return
      }
      // awaitWriteFinish debounces the half-written states most tools
      // produce (git checkout, agents streaming a Write tool call) so the
      // editor sees one settled change, not three partial ones.
      const watcher = watch(key, {
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 50 },
      })
      watcher.on('change', () => {
        void stat(key)
          .then(s =>
            broadcast({
              root: params.root,
              path: params.path,
              kind: 'change',
              mtimeMs: s.mtimeMs,
            }),
          )
          .catch(() =>
            broadcast({
              root: params.root,
              path: params.path,
              kind: 'change',
              mtimeMs: null,
            }),
          )
      })
      watcher.on('unlink', () => {
        broadcast({ root: params.root, path: params.path, kind: 'unlink', mtimeMs: null })
      })
      watchers.set(key, { watcher, refs: 1 })
    },
  )

  ipcMain.handle(
    'editor-fs:unwatch',
    async (_evt, params: { root: string; path: string }) => {
      const key = resolveInsideRoot(params.root, params.path)
      const entry = watchers.get(key)
      if (!entry) return
      entry.refs -= 1
      if (entry.refs <= 0) {
        watchers.delete(key)
        await entry.watcher.close()
      }
    },
  )
}
