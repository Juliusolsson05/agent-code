import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { useAppStore } from '@renderer/app-state/store'
import { hasAppInteractionOwner } from '@renderer/lib/interaction-ownership'
import type { Workspace } from '@renderer/workspace/workspaceStore'

import { ExplorerPane } from '@renderer/features/editor/ui/ExplorerPane'
import { EditorWorkbench } from '@renderer/features/editor/ui/EditorWorkbench'
import { ConfirmDeleteDialog } from '@renderer/features/editor/ui/ConfirmDeleteDialog'
import { mapWithConcurrency } from '@renderer/features/editor/lib/boundedAsyncPool'
import { releaseEditorModelOwner } from '@renderer/features/editor/lib/editorModelRegistry'
import {
  hasRecoverableBufferChanges,
  isMissingRegularFileError,
} from '@renderer/features/editor/lib/bufferOps'
import { AiWorkspaceEditor } from '@renderer/features/ai-workspace/ui/AiWorkspaceEditor'

import {
  EMPTY_CWD_STATE,
  openPathsUnder,
  useGlobalEditorStore,
} from '@renderer/features/global-editor/store'
import {
  cancelAllPendingGlobalEditorFileOpens,
  cancelPendingGlobalEditorFileOpen,
  openFileInGlobalEditor,
} from '@renderer/features/global-editor/openFileInGlobalEditor'
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

function isDefinitelyMissingRestoredPath(error: string): boolean {
  return ['does not exist', 'not a file', 'is a directory', 'not a directory'].includes(error)
}

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
  const [saveAllPending, setSaveAllPending] = useState(false)
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
  // One epoch space covers revalidation, watcher reads, explicit reloads, and
  // writes. Buffer generation alone protects close/reopen; it cannot order two
  // operations within the same open lifetime when filesystem mtimes tie.
  const fileObservationEpochRef = useRef(new Map<string, number>())
  const { open, closeGlobalEditor } = useAppStore(
    useShallow(state => ({
      open: state.globalEditorOpen,
      closeGlobalEditor: state.closeGlobalEditor,
    })),
  )

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
    toggleEditorFullscreen,
    toggleFileTreeVisible,
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
      toggleEditorFullscreen: state.toggleEditorFullscreen,
      toggleFileTreeVisible: state.toggleFileTreeVisible,
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

  useEffect(() => {
    if (open) return
    // Fullscreen is a presentation mode of an OPEN editor, not a sticky user
    // preference. Reset it on every close route (keybind, command palette, or
    // app action) so a later Quick Open/Search does not unexpectedly hide the
    // entire workspace. The same boundary invalidates slow file reads.
    cancelAllPendingGlobalEditorFileOpens()
    if (editorFullscreen) setEditorFullscreen(false)
  }, [open, editorFullscreen, setEditorFullscreen])

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
    // A read started from the previous app tab is no longer a navigation
    // intent once the user changes project context. Without cancellation its
    // late completion can set activeCwd back and visually undo the tab switch.
    cancelAllPendingGlobalEditorFileOpens()
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
    let disposed = false
    void (async () => {
      const restored: string[] = []
      const restoredGenerations = new Map<string, number>()
      let retryableFailure = false
      for (const path of persistedTabs.fileOrder) {
        const result = await openFileInGlobalEditor({
          root: activeCwd,
          path,
          activate: false,
          focus: false,
        })
        const restoredBuffer = result.ok && result.opened
          ? useGlobalEditorStore.getState().byCwd[activeCwd]?.openFiles[path]
          : null
        if (restoredBuffer) {
          restored.push(path)
          restoredGenerations.set(path, restoredBuffer.generation)
        }
        if (disposed) {
          retryableFailure = true
          break
        }
        if (result.ok && result.opened) {
          if (!restoredBuffer) {
            // Pending opens intentionally report cancellation as a successful
            // no-op so ordinary navigation does not show an error after the
            // user switches roots. Restore has a stronger contract: `ok` only
            // counts when this cwd actually owns the resulting lifetime.
            retryableFailure = true
            break
          }
        } else if (result.ok) {
          retryableFailure = true
          break
        } else if (!isDefinitelyMissingRestoredPath(result.error)) retryableFailure = true
      }
      if (retryableFailure) {
        // Permission/transient IO failures are not evidence that the user's
        // remembered tabs ceased to exist. Remove any partial restore from the
        // live projection so the persistence merge keeps the previous paths,
        // then permit another attempt after a real cwd/editor reactivation.
        useGlobalEditorStore.setState(state => {
          const current = state.byCwd[activeCwd]
          const hasUserOwnedLifetime = current?.fileOrder.some(path => {
            const buffer = current.openFiles[path]
            return (
              !buffer ||
              restoredGenerations.get(path) !== buffer.generation ||
              hasRecoverableBufferChanges(buffer)
            )
          })
          if (hasUserOwnedLifetime) return state
          const byCwd = { ...state.byCwd }
          delete byCwd[activeCwd]
          return { byCwd }
        })
        rehydratedCwdsRef.current.delete(activeCwd)
        return
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
    return () => {
      disposed = true
    }
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
          void window.api
            .editorWatchFile({ root: nextRoot, path })
            .then(() => {
              const current = watchedFilesRef.current
              if (current.root === nextRoot && current.paths.has(path)) return
              // Main resolves only after Chokidar is ready. A tab close/root
              // switch can send its first unwatch before registration exists;
              // revoke again after the late success to close that race.
              void window.api.editorUnwatchFile({ root: nextRoot, path }).catch(() => undefined)
            })
            .catch(err => {
              const current = watchedFilesRef.current
              if (current.root !== nextRoot || !current.paths.has(path)) return
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
    // Reactivating a cwd can touch every remembered tab, each carrying up to
    // an 8 MB IPC response. Bound the refresh for the same reason Save All and
    // AI Workspace refresh are bounded: useful disk parallelism without a
    // project-sized burst of strings in both processes.
    void mapWithConcurrency(paths, 6, async path => {
        const observationKey = `${activeCwd}\0${path}`
        const observationEpoch = (fileObservationEpochRef.current.get(observationKey) ?? 0) + 1
        fileObservationEpochRef.current.set(observationKey, observationEpoch)
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
        if (stale || fileObservationEpochRef.current.get(observationKey) !== observationEpoch)
          return
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
        const deleted = isMissingRegularFileError(result.error)
        useGlobalEditorStore.getState().setFileError(activeCwd, path, result.error, {
          generation,
          conflict: deleted,
          externalChange: deleted ? 'deleted' : undefined,
        })
      })
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
    let disposed = false
    const unsubscribe = window.api.onEditorFileChanged(event => {
      if (event.root !== activeCwd) return
      const buf = useGlobalEditorStore.getState().byCwd[event.root]?.openFiles[event.path]
      if (!buf) return
      const observationKey = `${event.root}\0${event.path}`
      const sequence = (fileObservationEpochRef.current.get(observationKey) ?? 0) + 1
      fileObservationEpochRef.current.set(observationKey, sequence)
      if (event.kind === 'error') {
        const error = event.error ?? 'file watcher failed'
        const deleted = isMissingRegularFileError(error)
        setFileError(event.root, event.path, event.error ?? 'file watcher failed', {
          conflict: deleted,
          externalChange: deleted ? 'deleted' : undefined,
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
      // A watcher mtime is a hint, not a content/version identity. Filesystems
      // can reuse coarse mtimes for distinct writes, so equality must still be
      // re-read. The sequence closes the remaining ambiguity: two reads can
      // resolve out of order with equal mtimes, so only the newest event may
      // publish either content or an error for this buffer lifetime.
      void window.api
        .editorReadTextFile({ root: event.root, path: event.path })
        .catch(err => ({
          ok: false as const,
          error: err instanceof Error ? err.message : 'failed to refresh changed file',
        }))
        .then(result => {
          if (disposed || fileObservationEpochRef.current.get(observationKey) !== sequence) return
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
          const deleted = isMissingRegularFileError(result.error)
          setFileError(event.root, event.path, result.error, {
            generation: buf.generation,
            conflict: deleted,
            externalChange: deleted ? 'deleted' : undefined,
          })
        })
    })
    return () => {
      disposed = true
      unsubscribe()
    }
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
  const saveAllPendingRef = useRef(false)
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
  const revalidateAfterWrite = useCallback(
    async (root: string, path: string, generation: number): Promise<void> => {
      const observationKey = `${root}\0${path}`
      const observationEpoch = (fileObservationEpochRef.current.get(observationKey) ?? 0) + 1
      fileObservationEpochRef.current.set(observationKey, observationEpoch)
      const result = await window.api.editorReadTextFile({ root, path }).catch(err => ({
        ok: false as const,
        error: err instanceof Error ? err.message : 'failed to verify saved file',
      }))
      if (fileObservationEpochRef.current.get(observationKey) !== observationEpoch) return
      if (result.ok) {
        observeFileOnDisk(root, path, result.text, result.mtimeMs, result.version, generation)
        return
      }
      const deleted = isMissingRegularFileError(result.error)
      setFileError(root, path, result.error, {
        generation,
        conflict: deleted,
        externalChange: deleted ? 'deleted' : undefined,
      })
    },
    [observeFileOnDisk, setFileError],
  )

  const saveFile = useCallback(
    async (path: string, options?: { recreateDeleted?: boolean }): Promise<boolean> => {
      if (!activeCwd) return false
      const root = activeCwd
      return serializeFileWrite(`${root}\0${path}`, async () => {
        const buf = useGlobalEditorStore.getState().byCwd[root]?.openFiles[path]
        if (!buf || !hasRecoverableBufferChanges(buf)) return true
        if (buf.externalChange === 'deleted' && !options?.recreateDeleted) return false
        const observationKey = `${root}\0${path}`
        fileObservationEpochRef.current.set(
          observationKey,
          (fileObservationEpochRef.current.get(observationKey) ?? 0) + 1,
        )
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
          // A watcher read can begin after our atomic rename but before the
          // write IPC resolves. Invalidating that read is necessary to stop a
          // pre-write snapshot from overwriting the acknowledgement, but it
          // can also hide a newer agent write in the same window. One bounded
          // post-ack read closes both sides of the race.
          await revalidateAfterWrite(root, path, buf.generation)
          return true
        }
        fileObservationEpochRef.current.set(
          observationKey,
          (fileObservationEpochRef.current.get(observationKey) ?? 0) + 1,
        )
        setFileError(root, path, result.error, {
          conflict: result.conflict === true,
          externalChange: result.conflictKind,
          generation: buf.generation,
        })
        return false
      })
    },
    [activeCwd, acknowledgeFileWrite, revalidateAfterWrite, serializeFileWrite, setFileError],
  )

  const saveActive = useCallback(async () => {
    const activePath = cwdState.activeFilePath
    if (!activePath) return
    await saveFile(activePath)
  }, [cwdState.activeFilePath, saveFile])

  const saveAll = useCallback(async () => {
    if (!activeCwd || saveAllPendingRef.current) return
    const root = activeCwd
    const state = useGlobalEditorStore.getState().byCwd[root]
    const dirtyPaths = state?.fileOrder.filter(path => state.openFiles[path]?.dirty) ?? []
    if (dirtyPaths.length === 0) return
    saveAllPendingRef.current = true
    setSaveAllPending(true)
    try {
      // WHY four writes: each payload can contain a multi-megabyte source
      // buffer. Unbounded Promise.all creates a burst of IPC copies and disk
      // writes exactly when the user is trying to make editor state safe.
      // Four retains useful parallelism while bounding peak memory and I/O.
      const results = await mapWithConcurrency(dirtyPaths, 4, async path => ({
        path,
        saved: await saveFile(path),
      }))
      const firstFailure = results.find(result => !result.saved)
      if (firstFailure) {
        // Save errors already live on their own buffer. Selecting the first
        // failure makes that banner immediately actionable instead of leaving
        // a red tab somewhere off-screen after a bulk action.
        setActiveFile(root, firstFailure.path, { focus: false })
      }
    } finally {
      saveAllPendingRef.current = false
      setSaveAllPending(false)
    }
  }, [activeCwd, saveFile, setActiveFile])

  // Close + model disposal. The store owns the buffer's life; the model
  // registry owns the Monaco model keyed by absolute path — a successful
  // close is the one moment both end together (see editorModelRegistry).
  const closeFileAndDisposeModel = useCallback(
    (path: string, opts?: { force?: boolean }): boolean => {
      if (!activeCwd) return false
      const buffer = useGlobalEditorStore.getState().byCwd[activeCwd]?.openFiles[path]
      const closed = closeFileAction(activeCwd, path, opts)
      if (closed) {
        cancelPendingGlobalEditorFileOpen(activeCwd, path)
        fileObservationEpochRef.current.delete(`${activeCwd}\0${path}`)
        if (buffer) releaseEditorModelOwner(buffer.generation)
      }
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
      const observationKey = `${activeCwd}\0${path}`
      const observationEpoch = (fileObservationEpochRef.current.get(observationKey) ?? 0) + 1
      fileObservationEpochRef.current.set(observationKey, observationEpoch)
      const result = await window.api
        .editorReadTextFile({
          root: activeCwd,
          path,
        })
        .catch(err => ({
          ok: false as const,
          error: err instanceof Error ? err.message : 'failed to reload file',
        }))
      if (fileObservationEpochRef.current.get(observationKey) !== observationEpoch) return
      if (!result.ok) {
        const deleted = isMissingRegularFileError(result.error)
        setFileError(activeCwd, path, result.error, {
          conflict: deleted,
          externalChange: deleted ? 'deleted' : undefined,
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
        const observationKey = `${root}\0${path}`
        fileObservationEpochRef.current.set(
          observationKey,
          (fileObservationEpochRef.current.get(observationKey) ?? 0) + 1,
        )
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
          await revalidateAfterWrite(root, path, buf.generation)
          return true
        }
        fileObservationEpochRef.current.set(
          observationKey,
          (fileObservationEpochRef.current.get(observationKey) ?? 0) + 1,
        )
        setFileError(root, path, result.error, {
          conflict: result.conflict === true,
          externalChange: result.conflictKind,
          generation: buf.generation,
        })
        return false
      })
    },
    [activeCwd, acknowledgeFileWrite, revalidateAfterWrite, serializeFileWrite, setFileError],
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
      const caseInsensitiveActive = activeAbsolute ? /^[A-Za-z]:\//.test(activeAbsolute) : false
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
      return result.ok && result.opened
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
  const toolbarButtonClass = 'rounded px-1.5 py-0.5 text-muted hover:bg-surface-hi hover:text-ink'
  const editorToolbarActions = (
    <>
      <button
        type="button"
        onClick={toggleFileTreeVisible}
        title={fileTreeVisible ? 'Hide file list' : 'Show file list'}
        aria-label={fileTreeVisible ? 'Hide file list' : 'Show file list'}
        className={toolbarButtonClass}
      >
        Files
      </button>
      <button
        type="button"
        onClick={toggleEditorFullscreen}
        title={editorFullscreen ? 'Restore split editor' : 'Make editor fullscreen'}
        aria-label={editorFullscreen ? 'Restore split editor' : 'Make editor fullscreen'}
        className={toolbarButtonClass}
      >
        {editorFullscreen ? 'Split' : 'Full'}
      </button>
      <button
        type="button"
        onClick={closeGlobalEditor}
        title="Close Global Editor"
        aria-label="Close Global Editor"
        className={toolbarButtonClass}
      >
        Close
      </button>
    </>
  )
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
            toolbarActions={editorToolbarActions}
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
                      // The buffer generation remains its logical owner. The
                      // registry recreates its immutable Monaco URI on the next
                      // mount; text/view state survive, while undo necessarily
                      // resets because Monaco cannot retarget a model URI.
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
                          cancelPendingGlobalEditorFileOpen(activeCwd, openPath)
                          fileObservationEpochRef.current.delete(`${activeCwd}\0${openPath}`)
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
                onSaveAll={() => void saveAll()}
                saveAllPending={saveAllPending}
                onSaveThenClose={saveThenClose}
                onReloadFromDisk={path => void reloadFromDisk(path)}
                onOverwriteDisk={path => void overwriteDisk(path)}
                onSelectionRevealed={clearRevealedSelection}
                onFocusRequestHandled={clearRequestedFocus}
                toolbarActions={editorToolbarActions}
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
