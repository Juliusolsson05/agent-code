import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { useAppStore } from '@renderer/app-state/store'
import { hasAppInteractionOwner } from '@renderer/lib/interaction-ownership'
import type { Workspace } from '@renderer/workspace/workspaceStore'

import { ExplorerPane } from '@renderer/features/editor/ui/ExplorerPane'
import { EditorWorkbench } from '@renderer/features/editor/ui/EditorWorkbench'
import { ConfirmDeleteDialog } from '@renderer/features/editor/ui/ConfirmDeleteDialog'
import { releaseEditorModelOwner } from '@renderer/features/editor/lib/editorModelRegistry'
import { hasRecoverableBufferChanges } from '@renderer/features/editor/lib/bufferOps'
import { AiWorkspaceEditor } from '@renderer/features/ai-workspace/ui/AiWorkspaceEditor'

import {
  EMPTY_CWD_STATE,
  openPathsUnder,
  useGlobalEditorStore,
} from '@renderer/features/global-editor/store'
import { openFileInGlobalEditor } from '@renderer/features/global-editor/openFileInGlobalEditor'
import { QuickOpenOverlay } from '@renderer/features/global-editor/ui/QuickOpenOverlay'
import { ContentSearchOverlay } from '@renderer/features/global-editor/ui/ContentSearchOverlay'
import {
  loadPersistedGlobalEditorState,
  startGlobalEditorPersistence,
} from '@renderer/features/global-editor/lib/globalEditorPersistence'
import { useFocusedAgentCwd } from '@renderer/features/global-editor/useFocusedAgentCwd'
import { SplitHandle } from '@renderer/features/shared/SplitHandle'
import { useResizableSplitter } from '@renderer/features/shared/useResizableSplitter'

// Splitter geometry. SPLITTER_PX is the visual width of the
// draggable bar between the editor and the workspace. We avoid
// using percent-only positions so a 12px hit target stays
// reliably grabbable regardless of viewport width.
const SPLITTER_PX = 6
const SPLITTER_HIT_PX = 12 // wider hit-area than visible bar

type Props = {
  /** Render slot for the existing workspace UI (dispatch / tile /
   *  spotlight). The shell renders this on the right when the
   *  overlay is open, OR full-bleed when the overlay is off. Either
   *  way the wrapped subtree is unchanged — that's the whole point
   *  of the overlay model. */
  children: ReactNode
  /** Needed for cwd derivation (focused agent → cwd). Passed in
   *  rather than imported via a hook so the shell is a pure
   *  function of its props for the storybook / testing case. */
  workspace: Workspace
}

// Global Editor overlay.
//
// WHY this shape (one shell that wraps the entire workspace area):
// - The user spec was explicit: the right pane is "the normal
//   looks", just shrunk. The existing dispatch / tile / spotlight
//   surfaces should not need to know the overlay exists. Wrapping
//   them in a flex sibling and letting them flex into the
//   available width is the cleanest way to achieve that.
// - The alternative (toggling a renderer alongside the workspace
//   inside each surface) would mean every mode has to opt into
//   the overlay independently. That's both more code and more
//   ways for the overlay to break per-mode.
//
// WHY splitter geometry persists only in renderer localStorage: it is visual
// chrome, not project data or unsaved source content. Persisting it alongside
// tab paths makes the editor feel stable across restarts without adding a
// main-process preference channel or a second source-content persistence path.
//
// WHY we drop a global mouse listener while dragging (instead of
// putting onMouseMove on the splitter itself): if the user
// drags fast enough the cursor outpaces the splitter and onMouseMove
// stops firing on the element. window-level mouse capture
// guarantees we keep receiving move events until mouseup.
// `useResizableSplitter` encapsulates that mechanic; see its docs.
export function GlobalEditorShell({ children, workspace }: Props) {
  const [pendingExplorerDelete, setPendingExplorerDelete] = useState<{
    path: string
    dirtyPaths: string[]
    resolve: (confirmed: boolean) => void
  } | null>(null)
  const explorerDeleteSnapshotsRef = useRef<{
    root: string
    requestedPath: string
    buffers: Map<string, { generation: number; currentText: string }>
  } | null>(null)
  const { open } = useAppStore(useShallow(state => ({ open: state.globalEditorOpen })))

  // Active tab id + the cwd of whatever command-target the user is
  // pointing at right now. WHY both:
  //
  // The original sync derived from `commandTargetSessionId` AS A DEP,
  // which reflects every focus change (pane-to-pane in grid, row-
  // to-row in dispatch). That meant moving focus inside the same
  // tab would fire the cwd-sync effect below, and the editor would
  // throw away its open tabs and reload the explorer — even though
  // the user hadn't actually moved between projects. The complaint
  // ("changing agents in the same tab reloaded the editor,
  // completely useless") is exactly that loop.
  //
  // The new contract: read `focusedCwd` here on every render (cheap;
  // we already need workspace state), but only COMMIT it to the
  // editor store when `activeTabId` changes — see the
  // lastSyncedTabIdRef effect below. Within-tab focus shifts (grid
  // or dispatch) don't appear in the effect's dep list, so they
  // don't trigger anything.
  //
  // WHY we use `useFocusedAgentCwd` rather than reading
  // `tab.focusedSessionId` directly: a tab in dispatch mode has
  // `tab.focusedSessionId === null` (focus lives on
  // `dispatchMode.focusedSessionId` instead). Reading the raw tab
  // field would make the editor look empty for any dispatch-mode
  // user. The hook goes through `commandTargetSessionId`, which
  // already handles both surfaces correctly.
  const activeTabId = workspace.state.activeTabId
  const focusedCwd = useFocusedAgentCwd(workspace)

  const {
    splitterRatio,
    setSplitterRatio,
    fileTreeWidthPx,
    setFileTreeWidthPx,
    fileTreeVisible,
    aiWorkspaceId,
    aiWorkspaceVisible,
    closeAiWorkspace,
    quickOpenOpen,
    setQuickOpenOpen,
    contentSearchOpen,
    setContentSearchOpen,
    editorFullscreen,
    setEditorFullscreen,
  } = useGlobalEditorStore(
    useShallow(state => ({
      splitterRatio: state.splitterRatio,
      setSplitterRatio: state.setSplitterRatio,
      fileTreeWidthPx: state.fileTreeWidthPx,
      setFileTreeWidthPx: state.setFileTreeWidthPx,
      fileTreeVisible: state.fileTreeVisible,
      aiWorkspaceId: state.aiWorkspaceId,
      aiWorkspaceVisible: state.aiWorkspaceVisible,
      closeAiWorkspace: state.closeAiWorkspace,
      quickOpenOpen: state.quickOpenOpen,
      setQuickOpenOpen: state.setQuickOpenOpen,
      contentSearchOpen: state.contentSearchOpen,
      setContentSearchOpen: state.setContentSearchOpen,
      editorFullscreen: state.editorFullscreen,
      setEditorFullscreen: state.setEditorFullscreen,
    })),
  )
  const {
    activeCwd,
    setActiveCwd,
    setActiveFile,
    updateFileText,
    setFileError,
    clearFileSelection,
    clearFileFocusRequest,
    acknowledgeFileWrite,
    replaceFileFromDisk,
    observeFileOnDisk,
    closeFileAction,
    renameOpenPath,
    cwdState,
  } = useGlobalEditorStore(
    useShallow(state => {
      const byCwd = state.byCwd
      const aCwd = state.activeCwd
      // EMPTY_CWD_STATE is a MODULE-SCOPE singleton — must NOT
      // be replaced with an inline `{ fileOrder: [], ... }` here.
      // Inline objects have a fresh reference every selector
      // call, defeat useShallow's equality check, and put the
      // renderer in an infinite re-render loop (black screen +
      // runaway memory). See note in store.ts.
      return {
        activeCwd: aCwd,
        setActiveCwd: state.setActiveCwd,
        setActiveFile: state.setActiveFile,
        updateFileText: state.updateFileText,
        setFileError: state.setFileError,
        clearFileSelection: state.clearFileSelection,
        clearFileFocusRequest: state.clearFileFocusRequest,
        acknowledgeFileWrite: state.acknowledgeFileWrite,
        replaceFileFromDisk: state.replaceFileFromDisk,
        observeFileOnDisk: state.observeFileOnDisk,
        closeFileAction: state.closeFile,
        renameOpenPath: state.renameOpenPath,
        cwdState: (aCwd && byCwd[aCwd]) || EMPTY_CWD_STATE,
      }
    }),
  )
  const active = cwdState.activeFilePath
    ? (cwdState.openFiles[cwdState.activeFilePath] ?? null)
    : null

  // Sync the editor's active cwd ONLY when the user navigates between
  // tabs. The dep list is intentionally `activeTabId` — not the
  // focused-cwd we'd derive globally — so pane-focus changes within
  // the same tab don't trigger this effect at all. Even if the tab's
  // currently-focused pane changes cwd, the editor stays put: the
  // last cwd we captured when entering this tab is what we keep
  // showing. We also use a ref to remember the last tab we synced
  // for, so a re-render that doesn't change activeTabId (because
  // some other slice changed) never reaches setActiveCwd either.
  const lastSyncedTabIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!open) {
      // Reopening the editor is an explicit request to follow the currently
      // focused agent even when the app tab id itself did not change while the
      // editor was hidden.
      lastSyncedTabIdRef.current = null
      return
    }
    if (lastSyncedTabIdRef.current === activeTabId) return
    lastSyncedTabIdRef.current = activeTabId ?? null
    if (focusedCwd === activeCwd) return
    setActiveCwd(focusedCwd)
    // focusedCwd is intentionally read here rather than listed as a
    // dep — it changes on every within-tab focus shift, which is
    // exactly the noise this effect is designed to ignore. We only
    // want to react to activeTabId transitions (and to `open`
    // changing, which captures the first-mount-of-the-overlay case
    // where activeTabId hadn't yet been synced).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeTabId, setActiveCwd])

  // Persistence writer — exactly one subscriber for the app (this shell
  // is a singleton wrapper around the workspace area).
  useEffect(() => startGlobalEditorPersistence(), [])

  // Rehydrate persisted tabs when a cwd becomes active with no live
  // state. Sequential opens preserve fileOrder (parallel opens would
  // race the store's append). Missing/renamed files fail silently — the
  // read errors and that tab simply doesn't come back, which is correct
  // for paths-only persistence. The ref makes rehydration once-per-cwd
  // per app run, so closing all tabs doesn't resurrect them on the next
  // tab switch.
  const rehydratedCwdsRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!open || !activeCwd) return
    if (rehydratedCwdsRef.current.has(activeCwd)) return
    rehydratedCwdsRef.current.add(activeCwd)
    const live = useGlobalEditorStore.getState().byCwd[activeCwd]
    // Presence, not tab count, means live state wins. An empty cwd is a
    // tombstone created by closing its final tab (or by a failed restore); using
    // `fileOrder.length > 0` resurrected deliberately closed tabs.
    if (live) return
    const persistedTabs = loadPersistedGlobalEditorState()?.tabsByCwd[activeCwd]
    if (!persistedTabs) return
    void (async () => {
      const restored: string[] = []
      for (const path of persistedTabs.fileOrder) {
        const result = await openFileInGlobalEditor({
          root: activeCwd,
          path,
          activate: false,
          focus: false,
        })
        if (result.ok) restored.push(path)
      }
      const current = useGlobalEditorStore.getState()
      if (!current.byCwd[activeCwd] && restored.length === 0) {
        // Persist the empty result into live state so an all-missing restore is
        // pruned by the next persistence flush instead of retried forever.
        useGlobalEditorStore.setState(state => ({
          byCwd: { ...state.byCwd, [activeCwd]: EMPTY_CWD_STATE },
        }))
        return
      }
      const activePath =
        (persistedTabs.activeFilePath && restored.includes(persistedTabs.activeFilePath)
          ? persistedTabs.activeFilePath
          : null) ?? restored[restored.length - 1]
      if (
        activePath &&
        current.activeCwd === activeCwd &&
        current.byCwd[activeCwd]?.activeFilePath == null
      ) {
        useGlobalEditorStore.getState().setActiveFile(activeCwd, activePath)
      }
    })()
  }, [open, activeCwd])

  // Keep main-process file watchers aligned with the open buffer set.
  // Only the active cwd's buffers are watched: background cwd states are
  // dormant (not rendered, not editable) and their buffers revalidate
  // against disk on reactivation via openFileInGlobalEditor's
  // read-on-open, so watching them would spend fs watchers on files
  // nobody is looking at.
  const watchedFilesRef = useRef<{ root: string | null; paths: Set<string> }>({
    root: null,
    paths: new Set(),
  })
  useEffect(() => {
    const previous = watchedFilesRef.current
    const nextRoot = open ? activeCwd : null
    const nextPaths = new Set(nextRoot ? cwdState.fileOrder : [])

    // WHY diff instead of effect-cleanup/re-register: opening one new tab used
    // to unwatch and rewatch every existing tab, turning N opens into O(N²)
    // IPC and racing short gaps where external changes could be missed.
    for (const path of previous.paths) {
      if (previous.root !== nextRoot || !nextPaths.has(path)) {
        if (previous.root) {
          void window.api.editorUnwatchFile({ root: previous.root, path }).catch(() => undefined)
        }
      }
    }
    for (const path of nextPaths) {
      if (previous.root !== nextRoot || !previous.paths.has(path)) {
        if (nextRoot) {
          void window.api.editorWatchFile({ root: nextRoot, path }).catch(err => {
            const buffer = useGlobalEditorStore.getState().byCwd[nextRoot]?.openFiles[path]
            if (!buffer) return
            setFileError(
              nextRoot,
              path,
              err instanceof Error ? err.message : 'failed to watch file for changes',
              { generation: buffer.generation },
            )
          })
        }
      }
    }
    watchedFilesRef.current = { root: nextRoot, paths: nextPaths }
  }, [open, activeCwd, cwdState.fileOrder, setFileError])

  useEffect(
    () => () => {
      const watched = watchedFilesRef.current
      if (!watched.root) return
      for (const path of watched.paths) {
        void window.api.editorUnwatchFile({ root: watched.root, path }).catch(() => undefined)
      }
    },
    [],
  )

  // Background cwd buffers are deliberately not watched. Re-observe every
  // open path when that cwd becomes visible again so a clean buffer catches up
  // and a dirty one gains an explicit conflict without losing its baseline.
  useEffect(() => {
    if (!open || !activeCwd) return
    let stale = false
    const paths = useGlobalEditorStore.getState().byCwd[activeCwd]?.fileOrder ?? []
    void Promise.all(
      paths.map(async path => {
        const generation =
          useGlobalEditorStore.getState().byCwd[activeCwd]?.openFiles[path]?.generation
        if (generation == null) return
        const result = await window.api
          .editorReadTextFile({
            root: activeCwd,
            path,
          })
          .catch(err => ({
            ok: false as const,
            error: err instanceof Error ? err.message : 'failed to revalidate file',
          }))
        if (stale) return
        if (result.ok) {
          useGlobalEditorStore
            .getState()
            .observeFileOnDisk(
              activeCwd,
              path,
              result.text,
              result.mtimeMs,
              result.version,
              generation,
            )
          return
        }
        const deleted = result.error === 'does not exist'
        useGlobalEditorStore.getState().setFileError(activeCwd, path, result.error, {
          generation,
          conflict: deleted,
          externalChange: deleted ? 'deleted' : undefined,
        })
      }),
    )
    return () => {
      stale = true
    }
  }, [open, activeCwd])

  // React to external writes pushed by the watcher. Clean buffers follow
  // disk silently — this is what makes agent writes show up live in an
  // open tab. Dirty buffers flip to the conflict banner instead: the user
  // has divergent edits and must pick a side (Reload / Overwrite).
  useEffect(() => {
    if (!open) return
    return window.api.onEditorFileChanged(event => {
      if (event.root !== activeCwd) return
      const buf = useGlobalEditorStore.getState().byCwd[event.root]?.openFiles[event.path]
      if (!buf) return
      if (event.kind === 'error') {
        setFileError(event.root, event.path, event.error ?? 'file watcher failed', {
          generation: buf.generation,
        })
        return
      }
      if (event.kind === 'unlink') {
        setFileError(event.root, event.path, 'file was deleted on disk', {
          conflict: true,
          externalChange: 'deleted',
          generation: buf.generation,
        })
        return
      }
      // Chokidar also reports our own successful write. Matching mtimes are an
      // acknowledgement already reflected in state; skipping the read avoids
      // a redundant round trip and, more importantly, avoids racing a second
      // save that has already started from a newer baseline.
      if (event.mtimeMs != null && event.mtimeMs === buf.mtimeMs) return
      void window.api
        .editorReadTextFile({ root: event.root, path: event.path })
        .catch(err => ({
          ok: false as const,
          error: err instanceof Error ? err.message : 'failed to refresh changed file',
        }))
        .then(result => {
          if (result.ok) {
            observeFileOnDisk(
              event.root,
              event.path,
              result.text,
              result.mtimeMs,
              result.version,
              buf.generation,
            )
            return
          }
          const deleted = result.error === 'does not exist'
          setFileError(event.root, event.path, result.error, {
            generation: buf.generation,
            conflict: deleted,
            externalChange: deleted ? 'deleted' : undefined,
          })
        })
    })
  }, [open, activeCwd, observeFileOnDisk, setFileError])

  // Outer splitter (editor pane ↔ workspace pane). Ratio-based.
  // We measure against the OUTER container's bounding rect so the
  // ratio means "fraction of full overlay width allocated to the
  // editor side."
  const outerContainerRef = useRef<HTMLDivElement | null>(null)
  const outerSplitter = useResizableSplitter({
    onDrag: useCallback(
      (clientX: number) => {
        const el = outerContainerRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        if (rect.width <= 0) return
        setSplitterRatio((clientX - rect.left) / rect.width)
      },
      [setSplitterRatio],
    ),
  })

  const pendingFileWritesRef = useRef(new Map<string, Promise<void>>())
  const serializeFileWrite = useCallback(
    async (key: string, task: () => Promise<boolean>): Promise<boolean> => {
      const previous = pendingFileWritesRef.current.get(key) ?? Promise.resolve()
      let release!: () => void
      const current = new Promise<void>(resolve => {
        release = resolve
      })
      pendingFileWritesRef.current.set(key, current)
      await previous.catch(() => undefined)
      try {
        return await task()
      } finally {
        release()
        if (pendingFileWritesRef.current.get(key) === current) {
          pendingFileWritesRef.current.delete(key)
        }
      }
    },
    [],
  )

  // Save handler — wired into MonacoFileEditor's Cmd+S (via saveActive)
  // and the confirm dialog's Save & Close (via saveThenClose). Reads the
  // buffer, writes to disk via the editorFs IPC, then acknowledges exactly
  // the submitted snapshot
  // on success. The mtime guard matters more once main caches reads:
  // cache invalidation keeps this process fresh, but it cannot see
  // every external editor/agent write before save. Passing the last
  // observed mtime makes "agent changed this while I was typing"
  // fail closed instead of overwriting a newer disk version — and the
  // `conflict` flag routes that failure to the banner's Reload/Overwrite
  // actions rather than a dead-end error string.
  const saveFile = useCallback(
    async (path: string, options?: { recreateDeleted?: boolean }): Promise<boolean> => {
      if (!activeCwd) return false
      const root = activeCwd
      return serializeFileWrite(`${root}\0${path}`, async () => {
        const buf = useGlobalEditorStore.getState().byCwd[root]?.openFiles[path]
        if (!buf || !hasRecoverableBufferChanges(buf)) return true
        if (buf.externalChange === 'deleted' && !options?.recreateDeleted) return false
        const writtenText = buf.currentText
        const result = await window.api
          .editorWriteTextFile({
            root,
            path,
            text: writtenText,
            expectedVersion: options?.recreateDeleted ? null : buf.diskVersion,
          })
          .catch(err => ({
            ok: false as const,
            error: err instanceof Error ? err.message : 'failed to save file',
            conflict: false,
            conflictKind: undefined,
          }))
        if (result.ok) {
          acknowledgeFileWrite(
            root,
            path,
            writtenText,
            result.mtimeMs,
            result.version,
            buf.generation,
          )
          return true
        }
        setFileError(root, path, result.error, {
          conflict: result.conflict === true,
          externalChange: result.conflictKind,
          generation: buf.generation,
        })
        return false
      })
    },
    [activeCwd, acknowledgeFileWrite, serializeFileWrite, setFileError],
  )

  const saveActive = useCallback(async () => {
    const activePath = cwdState.activeFilePath
    if (!activePath) return
    await saveFile(activePath)
  }, [cwdState.activeFilePath, saveFile])

  // Close + model disposal. The store owns the buffer's life; the model
  // registry owns the Monaco model keyed by absolute path — a successful
  // close is the one moment both end together (see editorModelRegistry).
  const closeFileAndDisposeModel = useCallback(
    (path: string, opts?: { force?: boolean }): boolean => {
      if (!activeCwd) return false
      const buffer = useGlobalEditorStore.getState().byCwd[activeCwd]?.openFiles[path]
      const closed = closeFileAction(activeCwd, path, opts)
      if (closed && buffer) releaseEditorModelOwner(buffer.generation)
      return closed
    },
    [activeCwd, closeFileAction],
  )

  const saveThenClose = useCallback(
    async (path: string): Promise<boolean> => {
      if (!activeCwd) return false
      const buffer = useGlobalEditorStore.getState().byCwd[activeCwd]?.openFiles[path]
      const ok = await saveFile(path, {
        // The dialog labels this branch "Recreate & Close". Passing null is
        // therefore an explicit user-authorized recreation, never a side
        // effect of ordinary Cmd+S after another actor deleted the file.
        recreateDeleted: buffer?.externalChange === 'deleted',
      })
      if (!ok) return false
      return closeFileAndDisposeModel(path)
    },
    [activeCwd, saveFile, closeFileAndDisposeModel],
  )

  // Banner recovery actions for the conflict state. Reload = disk wins
  // (replaceFileFromDisk replaces the buffer with disk content and clears
  // dirty/conflict — exactly "discard my edits"). Overwrite = buffer
  // wins: expectedMtimeMs null skips the optimistic check ONCE, as an
  // explicit user decision rather than a default.
  const reloadFromDisk = useCallback(
    async (path: string) => {
      if (!activeCwd) return
      const before = useGlobalEditorStore.getState().byCwd[activeCwd]?.openFiles[path]
      if (!before) return
      const result = await window.api
        .editorReadTextFile({
          root: activeCwd,
          path,
        })
        .catch(err => ({
          ok: false as const,
          error: err instanceof Error ? err.message : 'failed to reload file',
        }))
      if (!result.ok) {
        setFileError(activeCwd, path, result.error, {
          generation: before.generation,
        })
        return
      }
      const current = useGlobalEditorStore.getState().byCwd[activeCwd]?.openFiles[path]
      if (!current || current.generation !== before.generation) return
      if (current.currentText === before.currentText) {
        replaceFileFromDisk(
          activeCwd,
          path,
          result.text,
          result.mtimeMs,
          result.version,
          before.generation,
        )
      } else {
        observeFileOnDisk(
          activeCwd,
          path,
          result.text,
          result.mtimeMs,
          result.version,
          before.generation,
        )
      }
    },
    [activeCwd, observeFileOnDisk, replaceFileFromDisk, setFileError],
  )

  const overwriteDisk = useCallback(
    async (path: string) => {
      if (!activeCwd) return
      const root = activeCwd
      await serializeFileWrite(`${root}\0${path}`, async () => {
        const buf = useGlobalEditorStore.getState().byCwd[root]?.openFiles[path]
        if (!buf) return false
        const writtenText = buf.currentText
        const result = await window.api
          .editorWriteTextFile({
            root,
            path,
            text: writtenText,
            expectedVersion: null,
          })
          .catch(err => ({
            ok: false as const,
            error: err instanceof Error ? err.message : 'failed to overwrite file',
            conflict: false,
            conflictKind: undefined,
          }))
        if (result.ok) {
          acknowledgeFileWrite(
            root,
            path,
            writtenText,
            result.mtimeMs,
            result.version,
            buf.generation,
          )
          return true
        }
        setFileError(root, path, result.error, {
          conflict: result.conflict === true,
          externalChange: result.conflictKind,
          generation: buf.generation,
        })
        return false
      })
    },
    [activeCwd, acknowledgeFileWrite, serializeFileWrite, setFileError],
  )

  // Open a file from the explorer. Reads via IPC, then commits to
  // the store as a fresh buffer (or refreshes savedText on an
  // already-open dirty file — store.openFile handles both).
  const openFileFromTree = useCallback(
    async (relativePath: string): Promise<{ ok: true } | { ok: false; error: string }> => {
      if (!activeCwd) return { ok: false, error: 'No project is active.' }
      return await openFileInGlobalEditor({
        root: activeCwd,
        path: relativePath,
      })
    },
    [activeCwd],
  )

  const openProjectDefinition = useCallback(
    async (absolutePath: string, line: number, column: number): Promise<boolean> => {
      if (!activeCwd) return false
      const activeAbsolute = active?.absolutePath.replace(/\\/g, '/')
      const activeRelative = active?.path.replace(/\\/g, '/').replace(/^\/+/, '')
      const caseInsensitiveActive = activeAbsolute
        ? /^[A-Za-z]:\//.test(activeAbsolute)
        : false
      const comparableActiveAbsolute = caseInsensitiveActive
        ? activeAbsolute?.toLowerCase()
        : activeAbsolute
      const comparableActiveRelative = caseInsensitiveActive
        ? activeRelative?.toLowerCase()
        : activeRelative
      const physicalRoot =
        activeAbsolute &&
        activeRelative &&
        comparableActiveAbsolute?.endsWith(`/${comparableActiveRelative}`)
          ? activeAbsolute.slice(0, -activeRelative.length - 1)
          : null
      const root = (physicalRoot ?? activeCwd).replace(/\\/g, '/').replace(/\/+$/, '')
      const target = absolutePath.replace(/\\/g, '/')
      // LSP locations originate outside our renderer trust boundary. Main has
      // already constrained the document that produced the request, but the
      // returned target can point at dependencies or arbitrary file URIs. Keep
      // navigation on the same project capability as Explorer reads instead
      // of turning Monaco's global opener into an unrestricted file picker.
      const caseInsensitive = /^[A-Za-z]:\//.test(root)
      const comparableRoot = caseInsensitive ? root.toLowerCase() : root
      const comparableTarget = caseInsensitive ? target.toLowerCase() : target
      if (!comparableTarget.startsWith(`${comparableRoot}/`)) return false
      const path = target.slice(root.length + 1)
      if (!path || path.split('/').some(part => part === '' || part === '..')) return false
      const result = await openFileInGlobalEditor({
        root: activeCwd,
        path,
        line,
        column,
      })
      return result.ok
    },
    [active?.absolutePath, active?.path, activeCwd],
  )

  const clearRevealedSelection = useCallback(
    (path: string) => {
      if (!activeCwd) return
      clearFileSelection(activeCwd, path)
    },
    [activeCwd, clearFileSelection],
  )

  const clearRequestedFocus = useCallback(
    (path: string) => {
      if (!activeCwd) return
      clearFileFocusRequest(activeCwd, path)
    },
    [activeCwd, clearFileFocusRequest],
  )

  const confirmExplorerDelete = useCallback(
    async (path: string): Promise<boolean> => {
      if (!activeCwd) return false
      const state = useGlobalEditorStore.getState().byCwd[activeCwd]
      const affectedPaths = state ? openPathsUnder(state, path) : []
      // Snapshot every affected buffer, including clean ones. Disk deletion
      // happens after an optional dialog and an IPC round trip; a buffer that
      // changes anywhere in that window must survive as recoverable content
      // instead of being force-closed by the deletion callback.
      explorerDeleteSnapshotsRef.current = {
        root: activeCwd,
        requestedPath: path,
        buffers: new Map(
          affectedPaths.flatMap(openPath => {
            const buffer = state?.openFiles[openPath]
            return buffer
              ? [
                  [
                    openPath,
                    {
                      generation: buffer.generation,
                      currentText: buffer.currentText,
                    },
                  ],
                ]
              : []
          }),
        ),
      }
      if (!state) return true
      const dirtyPaths = affectedPaths.filter(openPath => {
        const buffer = state.openFiles[openPath]
        return buffer ? hasRecoverableBufferChanges(buffer) : false
      })
      if (dirtyPaths.length === 0) return true
      return await new Promise<boolean>(resolve => {
        setPendingExplorerDelete({ path, dirtyPaths, resolve })
      })
    },
    [activeCwd],
  )

  // Escape exits fullscreen — but only when no editor overlay owns the
  // key (Quick Open / content search close themselves on Escape and must
  // not ALSO drop the user out of fullscreen with the same press).
  useEffect(() => {
    if (!open || !editorFullscreen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (event.defaultPrevented) return
      if (hasAppInteractionOwner()) return
      const { quickOpenOpen: qo, contentSearchOpen: cs } = useGlobalEditorStore.getState()
      if (qo || cs) return
      setEditorFullscreen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, editorFullscreen, setEditorFullscreen])

  // When open without a focused cwd (rare boot edge), still show
  // the split so the user sees the overlay engaged — but the
  // editor pane displays an empty-state hint instead of an
  // explorer pointed at nowhere.
  const leftPercent = (splitterRatio * 100).toFixed(2)
  const rightPercent = ((1 - splitterRatio) * 100).toFixed(2)
  return (
    // WHY h-full w-full instead of `flex-1`:
    //   The parent here is App.tsx's `<main>`, which has
    //   `flex-1 min-h-0 min-w-0 overflow-hidden` but is NOT itself a
    //   flex container — its parent (the screen-fill wrapper) is
    //   `flex` row, so <main> gets a row-cell with real height, but
    //   nothing inside <main> can size with `flex-1` because <main>
    //   has no flex-direction of its own. The original PR #77 code
    //   used `flex flex-1` here and the shell collapsed to zero
    //   height — visible symptom was the file tree and editor
    //   rendering as empty black columns even though the splitter
    //   was visible. `h-full w-full` fills <main> directly so the
    //   inner flex-row layout has real dimensions to distribute.
    <div
      ref={outerContainerRef}
      className="relative flex h-full w-full min-h-0 min-w-0 overflow-hidden"
    >
      <div
        className="flex flex-col min-h-0 overflow-hidden border-r border-border"
        style={{
          // Fullscreen: the editor takes the whole workspace area; the
          // wrapped workspace stays MOUNTED but display:none (below).
          // Unmounting would tear down every terminal/feed in the tab
          // (xterm buffers, scroll positions, in-flight renders) just
          // because the user wanted a big editor for a minute.
          display: open ? undefined : 'none',
          width: editorFullscreen ? '100%' : `calc(${leftPercent}% - ${SPLITTER_PX / 2}px)`,
        }}
      >
        {aiWorkspaceId && (
          <AiWorkspaceEditor
            key={aiWorkspaceId}
            workspaceId={aiWorkspaceId}
            visible={open && aiWorkspaceVisible}
            onClose={closeAiWorkspace}
          />
        )}
        {open && !aiWorkspaceVisible && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {activeCwd ? (
              <EditorWorkbench
                sidebar={
                  <ExplorerPane
                    key={activeCwd}
                    root={activeCwd}
                    activeFilePath={cwdState.activeFilePath}
                    onOpenFile={openFileFromTree}
                    onFileRenamed={(fromPath, toPath) => {
                      renameOpenPath(activeCwd, fromPath, toPath)
                      // The buffer generation remains its logical model owner.
                      // The next Monaco mount moves that owner to the new URI;
                      // the old viewer cleanup then disposes only if no other
                      // surface owns the same absolute file.
                    }}
                    onBeforeRename={(fromPath, toPath) => {
                      const state = useGlobalEditorStore.getState().byCwd[activeCwd]
                      if (!state) return true
                      const affected = openPathsUnder(state, fromPath)
                      const affectedSet = new Set(affected)
                      return affected.every(path => {
                        const suffix = path === fromPath ? '' : path.slice(fromPath.length)
                        const destination = `${toPath}${suffix}`
                        return !state.openFiles[destination] || affectedSet.has(destination)
                      })
                    }}
                    onFileDeleted={path => {
                      const state = useGlobalEditorStore.getState().byCwd[activeCwd]
                      const snapshot = explorerDeleteSnapshotsRef.current
                      explorerDeleteSnapshotsRef.current = null
                      const affected = new Set(state ? openPathsUnder(state, path) : [])
                      const matchingSnapshot =
                        snapshot?.root === activeCwd && snapshot.requestedPath === path
                          ? snapshot
                          : null
                      if (matchingSnapshot) {
                        for (const openPath of matchingSnapshot.buffers.keys()) {
                          affected.add(openPath)
                        }
                      }
                      for (const openPath of affected) {
                        const current =
                          useGlobalEditorStore.getState().byCwd[activeCwd]?.openFiles[openPath]
                        if (!current) continue
                        const before = matchingSnapshot?.buffers.get(openPath)
                        const unchanged =
                          before?.generation === current.generation &&
                          before.currentText === current.currentText
                        if (unchanged) {
                          closeFileAction(activeCwd, openPath, { force: true })
                          releaseEditorModelOwner(current.generation)
                          continue
                        }
                        setFileError(activeCwd, openPath, 'file was deleted on disk', {
                          conflict: true,
                          externalChange: 'deleted',
                          generation: current.generation,
                        })
                      }
                    }}
                    onBeforeDelete={confirmExplorerDelete}
                  />
                }
                sidebarVisible={fileTreeVisible}
                sidebarWidthPx={fileTreeWidthPx}
                onSidebarWidthChange={setFileTreeWidthPx}
                fileOrder={cwdState.fileOrder}
                openFiles={cwdState.openFiles}
                activeFilePath={cwdState.activeFilePath}
                activeFile={active}
                lspContext={
                  active
                    ? {
                        workspaceRoot: activeCwd,
                        filePath: active.path,
                        authorization: { kind: 'editor-root' },
                        openDefinition: openProjectDefinition,
                      }
                    : null
                }
                onActivateFile={(path, options) =>
                  setActiveFile(activeCwd, path, { focus: options.focusEditor })
                }
                onCloseFile={closeFileAndDisposeModel}
                onChangeFile={(path, text) => updateFileText(activeCwd, path, text)}
                onSave={() => void saveActive()}
                onSaveThenClose={saveThenClose}
                onReloadFromDisk={path => void reloadFromDisk(path)}
                onOverwriteDisk={path => void overwriteDisk(path)}
                onSelectionRevealed={clearRevealedSelection}
                onFocusRequestHandled={clearRequestedFocus}
              />
            ) : (
              <div className="flex flex-1 items-center justify-center px-8 text-center text-[11px] text-muted">
                Focus an agent to open its workspace in the editor.
              </div>
            )}
          </div>
        )}
      </div>
      {/*
        Outer splitter. The visual bar is SPLITTER_PX wide; the hit
        area (cursor and event surface) is wider so it's grabbable
        without pixel-perfect aim. While dragging we apply a cursor
        on the whole window via a sibling style block (rendered by
        the hook) so the cursor doesn't flicker as the splitter
        moves under it.
      */}
      {open && !editorFullscreen && (
        <SplitHandle
          dragging={outerSplitter.dragging}
          onMouseDown={outerSplitter.onMouseDown}
          hitSizePx={SPLITTER_HIT_PX}
          barSizePx={SPLITTER_PX}
          label="Resize editor and workspace panes"
          valueNow={Math.round(splitterRatio * 100)}
          valueMin={20}
          valueMax={80}
          onKeyboardDelta={direction => setSplitterRatio(splitterRatio + direction * 0.02)}
        />
      )}
      {open && !editorFullscreen && outerSplitter.cursorLock}
      <div
        className="flex flex-col min-h-0 overflow-hidden"
        style={
          !open
            ? { width: '100%' }
            : editorFullscreen
              ? { display: 'none' }
              : { width: `calc(${rightPercent}% - ${SPLITTER_PX / 2}px)` }
        }
      >
        {children}
      </div>
      {open && quickOpenOpen && activeCwd && (
        <QuickOpenOverlay root={activeCwd} onClose={() => setQuickOpenOpen(false)} />
      )}
      {open && contentSearchOpen && activeCwd && (
        <ContentSearchOverlay root={activeCwd} onClose={() => setContentSearchOpen(false)} />
      )}
      {pendingExplorerDelete && (
        <ConfirmDeleteDialog
          path={pendingExplorerDelete.path}
          dirtyPaths={pendingExplorerDelete.dirtyPaths}
          onCancel={() => {
            explorerDeleteSnapshotsRef.current = null
            pendingExplorerDelete.resolve(false)
            setPendingExplorerDelete(null)
          }}
          onConfirm={() => {
            pendingExplorerDelete.resolve(true)
            setPendingExplorerDelete(null)
          }}
        />
      )}
    </div>
  )
}
