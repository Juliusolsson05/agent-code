import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { useAppStore } from '@renderer/app-state/store'
import type { Workspace } from '@renderer/workspace/workspaceStore'

import { ExplorerPane } from '@renderer/features/editor/ui/ExplorerPane'
import { EditorTabs } from '@renderer/features/editor/ui/EditorTabs'
import { MonacoFileEditor } from '@renderer/features/editor/ui/MonacoFileEditor'
import { AiWorkspaceEditor } from '@renderer/features/ai-workspace/ui/AiWorkspaceEditor'

import { EMPTY_CWD_STATE, useGlobalEditorStore } from '@renderer/features/global-editor/store'
import { openFileInGlobalEditor } from '@renderer/features/global-editor/openFileInGlobalEditor'
import { useFocusedAgentCwd } from '@renderer/features/global-editor/useFocusedAgentCwd'
import { useResizableSplitter } from '@renderer/features/shared/useResizableSplitter'

// Splitter geometry. SPLITTER_PX is the visual width of the
// draggable bar between the editor and the workspace. We avoid
// using percent-only positions so a 12px hit target stays
// reliably grabbable regardless of viewport width.
const SPLITTER_PX = 6
const SPLITTER_HIT_PX = 12 // wider hit-area than visible bar

// Inner file-tree splitter geometry. We use a slightly thinner
// visible bar than the outer splitter (4 vs 6px) so the inner
// boundary reads visually as a sub-divider rather than a peer of
// the editor/workspace split. The hit area is still generous —
// pixel-perfect aim shouldn't be required to grab a 4px bar.
const FT_SPLITTER_PX = 4
const FT_SPLITTER_HIT_PX = 10

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
  } = useGlobalEditorStore(
    useShallow(state => ({
      splitterRatio: state.splitterRatio,
      setSplitterRatio: state.setSplitterRatio,
      fileTreeWidthPx: state.fileTreeWidthPx,
      setFileTreeWidthPx: state.setFileTreeWidthPx,
      fileTreeVisible: state.fileTreeVisible,
      aiWorkspaceId: state.aiWorkspaceId,
      closeAiWorkspace: state.closeAiWorkspace,
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

  // Inner splitter (file tree ↔ Monaco area), only used while the
  // tree is visible. Pixel-based, not ratio-based, because the
  // file tree wants a stable absolute width — narrower or wider
  // feels off depending on the user, but the tree never wants to
  // scale with the outer pane in a way that changes the number of
  // visible chars per filename row whenever the user touches the
  // outer splitter.
  //
  // Measure against the EDITOR-HALF container (the left side of the
  // outer split), not the overall overlay, because clientX − tree's
  // left edge gives us the user-intended width directly.
  const editorHalfRef = useRef<HTMLDivElement | null>(null)
  const treeSplitter = useResizableSplitter({
    enabled: fileTreeVisible,
    onDrag: useCallback(
      (clientX: number) => {
        const el = editorHalfRef.current
        if (!el) return
        const rect = el.getBoundingClientRect()
        setFileTreeWidthPx(clientX - rect.left)
      },
      [setFileTreeWidthPx],
    ),
  })

  // Save handler — wired into MonacoFileEditor's Cmd+S. Validates
  // we have an active cwd + active file, reads the buffer, writes
  // to disk via the editorFs IPC, then calls markFileSaved on
  // success. The mtime guard matters more once main caches reads:
  // cache invalidation keeps this process fresh, but it cannot see
  // every external editor/agent write before save. Passing the last
  // observed mtime makes "agent changed this while I was typing"
  // fail closed instead of overwriting a newer disk version.
  const saveActive = useCallback(async () => {
    if (!activeCwd) return
    const activePath = cwdState.activeFilePath
    if (!activePath) return
    const buf = cwdState.openFiles[activePath]
    if (!buf || !buf.dirty) return
    const result = await window.api.editorWriteTextFile({
      root: activeCwd,
      path: activePath,
      text: buf.currentText,
      expectedMtimeMs: buf.mtimeMs,
    })
    if (result.ok) {
      markFileSaved(activeCwd, activePath, buf.currentText, result.mtimeMs)
    } else {
      setFileError(activeCwd, activePath, result.error)
    }
  }, [activeCwd, cwdState, markFileSaved, setFileError])

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

  // While ANY splitter is dragging, lock the cursor globally. Both
  // hooks render their own `cursorLock` style tag — combining them
  // is fine; React will dedupe at the DOM level.
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
        ref={editorHalfRef}
        className="flex flex-col min-h-0 overflow-hidden border-r border-border"
        style={{ width: `calc(${leftPercent}% - ${SPLITTER_PX / 2}px)` }}
      >
        {aiWorkspaceId ? (
          <AiWorkspaceEditor workspaceId={aiWorkspaceId} onClose={closeAiWorkspace} />
        ) : activeCwd ? (
          <div className="flex flex-1 min-h-0 overflow-hidden">
            {/*
              File tree. Conditionally rendered — when
              `fileTreeVisible` is false the Monaco area expands to
              fill the editor half. Width is driven by
              `fileTreeWidthPx` (clamped in the store), NOT by
              `flex-1` or a percentage of the outer split, so the
              tree's column width feels stable as the user drags
              the outer splitter. `flex-shrink-0` is load-bearing:
              without it the tree would shrink when the editor half
              gets narrow, defeating the point of pixel-locking.
            */}
            {fileTreeVisible ? (
              <>
                <div
                  className="flex-shrink-0 overflow-hidden"
                  style={{ width: `${fileTreeWidthPx}px` }}
                >
                  <ExplorerPane
                    root={activeCwd}
                    activeFilePath={cwdState.activeFilePath}
                    onOpenFile={openFileFromTree}
                  />
                </div>
                {/*
                  Inner splitter. Same structure as the outer
                  splitter but thinner. Hit area wider than visible
                  bar (FT_SPLITTER_HIT_PX > FT_SPLITTER_PX) so it
                  can be grabbed without pixel-perfect aim. We don't
                  use a real <separator role> child because the
                  outer splitter already declares one and we want
                  this to read as a secondary divider, not a peer.
                */}
                <div
                  role="separator"
                  aria-orientation="vertical"
                  onMouseDown={treeSplitter.onMouseDown}
                  className="relative flex-shrink-0 cursor-col-resize select-none"
                  style={{ width: `${FT_SPLITTER_HIT_PX}px` }}
                >
                  <div
                    className={`absolute left-1/2 top-0 h-full -translate-x-1/2 ${
                      treeSplitter.dragging ? 'bg-accent' : 'bg-border'
                    } transition-colors`}
                    style={{ width: `${FT_SPLITTER_PX}px` }}
                  />
                </div>
              </>
            ) : null}
            <div className="flex flex-1 flex-col min-w-0 overflow-hidden">
              <EditorTabs
                fileOrder={cwdState.fileOrder}
                openFiles={cwdState.openFiles}
                activeFilePath={cwdState.activeFilePath}
                onActivate={path => setActiveFile(activeCwd, path)}
                onClose={path => closeFileAction(activeCwd, path)}
              />
              <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
                <MonacoFileEditor
                  file={active}
                  projectRoot={activeCwd}
                  onChange={(path, text) =>
                    updateFileText(activeCwd, path, text)
                  }
                  onSave={() => void saveActive()}
                  onSelectionRevealed={clearRevealedSelection}
                />
              </div>
            </div>
          </div>
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
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={outerSplitter.onMouseDown}
        className="relative flex-shrink-0 cursor-col-resize select-none"
        style={{ width: `${SPLITTER_HIT_PX}px` }}
      >
        <div
          className={`absolute left-1/2 top-0 h-full -translate-x-1/2 ${
            outerSplitter.dragging ? 'bg-accent' : 'bg-border'
          } transition-colors`}
          style={{ width: `${SPLITTER_PX}px` }}
        />
      </div>
      {outerSplitter.cursorLock}
      {treeSplitter.cursorLock}
      <div
        className="flex flex-col min-h-0 overflow-hidden"
        style={{ width: `calc(${rightPercent}% - ${SPLITTER_PX / 2}px)` }}
      >
        {children}
      </div>
    </div>
  )
}
