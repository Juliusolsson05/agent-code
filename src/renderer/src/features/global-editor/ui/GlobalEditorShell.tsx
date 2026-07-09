import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { useAppStore } from '@renderer/app-state/store'
import type { Workspace } from '@renderer/workspace/workspaceStore'

import { ExplorerPane } from '@renderer/features/editor/ui/ExplorerPane'
import { EditorWorkbench } from '@renderer/features/editor/ui/EditorWorkbench'
import {
  disposeEditorModel,
  editorModelKey,
} from '@renderer/features/editor/lib/editorModelRegistry'
import { AiWorkspaceEditor } from '@renderer/features/ai-workspace/ui/AiWorkspaceEditor'

import { EMPTY_CWD_STATE, useGlobalEditorStore } from '@renderer/features/global-editor/store'
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
// WHY the splitter ratio is renderer-only state (no IPC, no
// persistence): the splitter is purely visual chrome. Like
// CodeMirror's gutter width or VS Code's activity-bar position,
// it's a per-session preference at most. In-memory only (lost on
// app reload) is acceptable until we have a reason to add a
// persistence channel for it.
//
// WHY we drop a global mouse listener while dragging (instead of
// putting onMouseMove on the splitter itself): if the user
// drags fast enough the cursor outpaces the splitter and onMouseMove
// stops firing on the element. window-level mouse capture
// guarantees we keep receiving move events until mouseup.
// `useResizableSplitter` encapsulates that mechanic; see its docs.
export function GlobalEditorShell({ children, workspace }: Props) {
  const { open } = useAppStore(
    useShallow(state => ({ open: state.globalEditorOpen })),
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
    markFileSaved,
    closeFileAction,
    renameOpenFile,
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
        markFileSaved: state.markFileSaved,
        closeFileAction: state.closeFile,
        renameOpenFile: state.renameOpenFile,
        cwdState: (aCwd && byCwd[aCwd]) || EMPTY_CWD_STATE,
      }
    }),
  )

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
    if (!open) return
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
    if ((live?.fileOrder.length ?? 0) > 0) return // live state wins
    const persistedTabs = loadPersistedGlobalEditorState()?.tabsByCwd[activeCwd]
    if (!persistedTabs) return
    void (async () => {
      for (const path of persistedTabs.fileOrder) {
        await openFileInGlobalEditor({ root: activeCwd, path })
      }
      if (persistedTabs.activeFilePath) {
        useGlobalEditorStore
          .getState()
          .setActiveFile(activeCwd, persistedTabs.activeFilePath)
      }
    })()
  }, [open, activeCwd])

  // Keep main-process file watchers aligned with the open buffer set.
  // Only the active cwd's buffers are watched: background cwd states are
  // dormant (not rendered, not editable) and their buffers revalidate
  // against disk on reactivation via openFileInGlobalEditor's
  // read-on-open, so watching them would spend fs watchers on files
  // nobody is looking at.
  useEffect(() => {
    if (!open || !activeCwd) return
    const paths = cwdState.fileOrder
    for (const path of paths) {
      void window.api.editorWatchFile({ root: activeCwd, path })
    }
    return () => {
      for (const path of paths) {
        void window.api.editorUnwatchFile({ root: activeCwd, path })
      }
    }
  }, [open, activeCwd, cwdState.fileOrder])

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
      if (event.kind === 'unlink') {
        setFileError(event.root, event.path, 'file was deleted on disk', {
          conflict: true,
        })
        return
      }
      if (buf.dirty) {
        setFileError(
          event.root,
          event.path,
          'file changed on disk while you have unsaved edits',
          { conflict: true },
        )
        return
      }
      void window.api
        .editorReadTextFile({ root: event.root, path: event.path })
        .then(result => {
          if (result.ok) {
            markFileSaved(event.root, event.path, result.text, result.mtimeMs)
          }
        })
    })
  }, [open, activeCwd, markFileSaved, setFileError])

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

  // Save handler — wired into MonacoFileEditor's Cmd+S (via saveActive)
  // and the confirm dialog's Save & Close (via saveThenClose). Reads the
  // buffer, writes to disk via the editorFs IPC, then calls markFileSaved
  // on success. The mtime guard matters more once main caches reads:
  // cache invalidation keeps this process fresh, but it cannot see
  // every external editor/agent write before save. Passing the last
  // observed mtime makes "agent changed this while I was typing"
  // fail closed instead of overwriting a newer disk version — and the
  // `conflict` flag routes that failure to the banner's Reload/Overwrite
  // actions rather than a dead-end error string.
  const saveFile = useCallback(
    async (path: string): Promise<boolean> => {
      if (!activeCwd) return false
      const buf = useGlobalEditorStore.getState().byCwd[activeCwd]?.openFiles[path]
      if (!buf || !buf.dirty) return true
      const result = await window.api.editorWriteTextFile({
        root: activeCwd,
        path,
        text: buf.currentText,
        expectedMtimeMs: buf.mtimeMs,
      })
      if (result.ok) {
        markFileSaved(activeCwd, path, buf.currentText, result.mtimeMs)
        return true
      }
      setFileError(activeCwd, path, result.error, { conflict: result.conflict === true })
      return false
    },
    [activeCwd, markFileSaved, setFileError],
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
      const closed = closeFileAction(activeCwd, path, opts)
      if (closed) disposeEditorModel(editorModelKey(activeCwd, path))
      return closed
    },
    [activeCwd, closeFileAction],
  )

  const saveThenClose = useCallback(
    async (path: string): Promise<boolean> => {
      if (!activeCwd) return false
      const ok = await saveFile(path)
      if (ok) closeFileAndDisposeModel(path)
      return ok
    },
    [activeCwd, saveFile, closeFileAndDisposeModel],
  )

  // Banner recovery actions for the conflict state. Reload = disk wins
  // (markFileSaved replaces the buffer with disk content and clears
  // dirty/conflict — exactly "discard my edits"). Overwrite = buffer
  // wins: expectedMtimeMs null skips the optimistic check ONCE, as an
  // explicit user decision rather than a default.
  const reloadFromDisk = useCallback(
    async (path: string) => {
      if (!activeCwd) return
      const result = await window.api.editorReadTextFile({ root: activeCwd, path })
      if (!result.ok) {
        setFileError(activeCwd, path, result.error)
        return
      }
      markFileSaved(activeCwd, path, result.text, result.mtimeMs)
    },
    [activeCwd, markFileSaved, setFileError],
  )

  const overwriteDisk = useCallback(
    async (path: string) => {
      if (!activeCwd) return
      const buf = useGlobalEditorStore.getState().byCwd[activeCwd]?.openFiles[path]
      if (!buf) return
      const result = await window.api.editorWriteTextFile({
        root: activeCwd,
        path,
        text: buf.currentText,
        expectedMtimeMs: null,
      })
      if (result.ok) {
        markFileSaved(activeCwd, path, buf.currentText, result.mtimeMs)
      } else {
        setFileError(activeCwd, path, result.error, { conflict: result.conflict === true })
      }
    },
    [activeCwd, markFileSaved, setFileError],
  )

  // Open a file from the explorer. Reads via IPC, then commits to
  // the store as a fresh buffer (or refreshes savedText on an
  // already-open dirty file — store.openFile handles both).
  const openFileFromTree = useCallback(
    async (relativePath: string) => {
      if (!activeCwd) return
      await openFileInGlobalEditor({
        root: activeCwd,
        path: relativePath,
      })
    },
    [activeCwd],
  )

  const clearRevealedSelection = useCallback(
    (path: string) => {
      if (!activeCwd) return
      clearFileSelection(activeCwd, path)
    },
    [activeCwd, clearFileSelection],
  )

  // Escape exits fullscreen — but only when no editor overlay owns the
  // key (Quick Open / content search close themselves on Escape and must
  // not ALSO drop the user out of fullscreen with the same press).
  useEffect(() => {
    if (!open || !editorFullscreen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const { quickOpenOpen: qo, contentSearchOpen: cs } =
        useGlobalEditorStore.getState()
      if (qo || cs) return
      setEditorFullscreen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, editorFullscreen, setEditorFullscreen])

  // When the overlay is closed, render the workspace area
  // full-bleed. This is the "off" state — zero overhead, no extra
  // DOM, no event listeners.
  if (!open) return <>{children}</>

  // When open without a focused cwd (rare boot edge), still show
  // the split so the user sees the overlay engaged — but the
  // editor pane displays an empty-state hint instead of an
  // explorer pointed at nowhere.
  const leftPercent = (splitterRatio * 100).toFixed(2)
  const rightPercent = ((1 - splitterRatio) * 100).toFixed(2)
  const active = cwdState.activeFilePath
    ? cwdState.openFiles[cwdState.activeFilePath] ?? null
    : null

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
          width: editorFullscreen
            ? '100%'
            : `calc(${leftPercent}% - ${SPLITTER_PX / 2}px)`,
        }}
      >
        {aiWorkspaceId ? (
          <AiWorkspaceEditor workspaceId={aiWorkspaceId} onClose={closeAiWorkspace} />
        ) : activeCwd ? (
          <EditorWorkbench
            sidebar={
              <ExplorerPane
                root={activeCwd}
                activeFilePath={cwdState.activeFilePath}
                onOpenFile={openFileFromTree}
                onFileRenamed={(fromPath, toPath) => {
                  renameOpenFile(activeCwd, fromPath, toPath)
                  // The model URI embeds the old path — dispose it; the
                  // next mount recreates under the new URI. Undo history
                  // is lost on rename; acceptable for an explicit act.
                  disposeEditorModel(editorModelKey(activeCwd, fromPath))
                }}
                onFileDeleted={path => {
                  // Deleted on disk → force-close the buffer. A zombie
                  // tab that can only fail to save is worse than closing.
                  closeFileAction(activeCwd, path, { force: true })
                  disposeEditorModel(editorModelKey(activeCwd, path))
                }}
              />
            }
            sidebarVisible={fileTreeVisible}
            sidebarWidthPx={fileTreeWidthPx}
            onSidebarWidthChange={setFileTreeWidthPx}
            fileOrder={cwdState.fileOrder}
            openFiles={cwdState.openFiles}
            activeFilePath={cwdState.activeFilePath}
            activeFile={active}
            projectRoot={activeCwd}
            onActivateFile={path => setActiveFile(activeCwd, path)}
            onCloseFile={closeFileAndDisposeModel}
            onChangeFile={(path, text) => updateFileText(activeCwd, path, text)}
            onSave={() => void saveActive()}
            onSaveThenClose={saveThenClose}
            onReloadFromDisk={path => void reloadFromDisk(path)}
            onOverwriteDisk={path => void overwriteDisk(path)}
            onSelectionRevealed={clearRevealedSelection}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center px-8 text-center text-[11px] text-muted">
            Focus an agent to open its workspace in the editor.
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
      {!editorFullscreen && (
        <SplitHandle
          dragging={outerSplitter.dragging}
          onMouseDown={outerSplitter.onMouseDown}
          hitSizePx={SPLITTER_HIT_PX}
          barSizePx={SPLITTER_PX}
        />
      )}
      {!editorFullscreen && outerSplitter.cursorLock}
      <div
        className="flex flex-col min-h-0 overflow-hidden"
        style={
          editorFullscreen
            ? { display: 'none' }
            : { width: `calc(${rightPercent}% - ${SPLITTER_PX / 2}px)` }
        }
      >
        {children}
      </div>
      {quickOpenOpen && activeCwd && (
        <QuickOpenOverlay root={activeCwd} onClose={() => setQuickOpenOpen(false)} />
      )}
      {contentSearchOpen && activeCwd && (
        <ContentSearchOverlay
          root={activeCwd}
          onClose={() => setContentSearchOpen(false)}
        />
      )}
    </div>
  )
}
