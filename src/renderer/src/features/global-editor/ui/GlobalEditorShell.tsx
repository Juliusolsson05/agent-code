import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { useAppStore } from '@renderer/app-state/store'
import type { Workspace } from '@renderer/workspace/workspaceStore'

import { ExplorerPane } from '@renderer/features/editor/ui/ExplorerPane'
import { EditorTabs } from '@renderer/features/editor/ui/EditorTabs'
import { MonacoFileEditor } from '@renderer/features/editor/ui/MonacoFileEditor'

import { EMPTY_CWD_STATE, useGlobalEditorStore } from '@renderer/features/global-editor/store'
import { useFocusedAgentCwd } from '@renderer/features/global-editor/useFocusedAgentCwd'

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

  const { splitterRatio, setSplitterRatio } = useGlobalEditorStore(
    useShallow(state => ({
      splitterRatio: state.splitterRatio,
      setSplitterRatio: state.setSplitterRatio,
    })),
  )
  const {
    activeCwd,
    setActiveCwd,
    openFileAction,
    setActiveFile,
    updateFileText,
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
        openFileAction: state.openFile,
        setActiveFile: state.setActiveFile,
        updateFileText: state.updateFileText,
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

  // Splitter drag handling. We track in a ref so the move handler
  // doesn't re-create on every ratio change (which would tear
  // down + re-add the window listener mid-drag).
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [dragging, setDragging] = useState(false)

  const onSplitterMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      setDragging(true)
    },
    [],
  )

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => {
      const el = containerRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      if (rect.width <= 0) return
      const ratio = (e.clientX - rect.left) / rect.width
      setSplitterRatio(ratio)
    }
    const onUp = () => setDragging(false)
    // capture: true so we win against any drag-prevention on the
    // wrapped workspace pane underneath (e.g. xterm.js panes that
    // mouse-capture aggressively).
    window.addEventListener('mousemove', onMove, true)
    window.addEventListener('mouseup', onUp, true)
    return () => {
      window.removeEventListener('mousemove', onMove, true)
      window.removeEventListener('mouseup', onUp, true)
    }
  }, [dragging, setSplitterRatio])

  // Save handler — wired into MonacoFileEditor's Cmd+S. Validates
  // we have an active cwd + active file, reads the buffer, writes
  // to disk via the editorFs IPC, then calls markFileSaved on
  // success. Errors surface through setFileError on the buffer if
  // we add that path; for now we silently keep dirty.
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
    })
    if (result.ok) {
      markFileSaved(activeCwd, activePath, buf.currentText, result.mtimeMs)
    }
  }, [activeCwd, cwdState, markFileSaved])

  // Open a file from the explorer. Reads via IPC, then commits to
  // the store as a fresh buffer (or refreshes savedText on an
  // already-open dirty file — store.openFile handles both).
  const openFileFromTree = useCallback(
    async (relativePath: string) => {
      if (!activeCwd) return
      const result = await window.api.editorReadTextFile({
        root: activeCwd,
        path: relativePath,
      })
      if (!result.ok) return
      openFileAction({
        cwd: activeCwd,
        path: relativePath,
        text: result.text,
        mtimeMs: result.mtimeMs,
      })
    },
    [activeCwd, openFileAction],
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
      ref={containerRef}
      className="relative flex h-full w-full min-h-0 min-w-0 overflow-hidden"
    >
      <div
        className="flex flex-col min-h-0 overflow-hidden border-r border-border"
        style={{ width: `calc(${leftPercent}% - ${SPLITTER_PX / 2}px)` }}
      >
        {activeCwd ? (
          <div className="flex flex-1 min-h-0 overflow-hidden">
            <div className="w-[240px] flex-shrink-0 border-r border-border overflow-hidden">
              <ExplorerPane
                root={activeCwd}
                activeFilePath={cwdState.activeFilePath}
                onOpenFile={openFileFromTree}
              />
            </div>
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
        Splitter. The visual bar is SPLITTER_PX wide; the hit area
        (cursor and event surface) is wider so it's grabbable
        without pixel-perfect aim. While dragging we apply a
        cursor on the whole window via a sibling style block so
        the cursor doesn't flicker as the splitter moves under it.
      */}
      <div
        role="separator"
        aria-orientation="vertical"
        onMouseDown={onSplitterMouseDown}
        className="relative flex-shrink-0 cursor-col-resize select-none"
        style={{ width: `${SPLITTER_HIT_PX}px` }}
      >
        <div
          className={`absolute left-1/2 top-0 h-full -translate-x-1/2 ${
            dragging ? 'bg-accent' : 'bg-border'
          } transition-colors`}
          style={{ width: `${SPLITTER_PX}px` }}
        />
      </div>
      {dragging ? (
        // While dragging, force the col-resize cursor everywhere
        // so the user doesn't see it change when the pointer
        // crosses pane boundaries. Removed when dragging ends.
        <style>{`* { cursor: col-resize !important; }`}</style>
      ) : null}
      <div
        className="flex flex-col min-h-0 overflow-hidden"
        style={{ width: `calc(${rightPercent}% - ${SPLITTER_PX / 2}px)` }}
      >
        {children}
      </div>
    </div>
  )
}
