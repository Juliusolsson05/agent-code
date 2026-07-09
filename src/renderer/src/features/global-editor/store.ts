import { create } from 'zustand'

import { normalizeCodeLanguage } from '@shared/code/language'
import type { EditorFileBuffer } from '@renderer/features/editor/types'
import {
  makeBuffer,
  withError,
  withSaved,
  withTextUpdate,
} from '@renderer/features/editor/lib/bufferOps'
// Benign module cycle — see the MODULE-CYCLE NOTE in
// globalEditorPersistence.ts before "fixing" this import.
import { loadPersistedGlobalEditorState } from '@renderer/features/global-editor/lib/globalEditorPersistence'

// Per-cwd workspace state for the Global Editor overlay.
//
// WHY per-cwd: the overlay's editor "workspace" is whichever cwd
// the currently-focused agent uses. As the user scrolls through
// dispatch and lands on agents in different projects, the file
// tree and open tabs should follow — but switching BACK to the
// previous project should restore that project's open tabs and
// cursor positions, not start fresh. Otherwise rapid dispatch
// navigation punishes the user by wiping the editor every few
// seconds.
//
// HISTORY: this store replaced `useEditorStore` (the deleted
// features/editor/store.ts from the prior single-workspace "Code
// Editor" mode, feat/code-editor). That store cleared open buffers on
// every projectRoot change — the opposite of the per-cwd memory this
// one exists to provide. The semantics it pioneered (dirty-preserving
// reopen, dirty-close guard) live on here; the buffer math itself is
// now shared with AI Workspace via features/editor/lib/bufferOps.
//
// PERSISTENCE (#513): open-tab PATHS and pane geometry survive app
// restarts via lib/globalEditorPersistence (localStorage). The original
// in-memory-only rule was about UNSAVED FILE CONTENTS — "every
// persistence path is a potential leak" per
// session-respawn-oom-root-cause.md — and that half still stands as a
// hard invariant: buffer text is NEVER persisted anywhere. Restart wipes
// unsaved edits; the tabs come back by re-reading disk on rehydrate
// (GlobalEditorShell's rehydration effect), so there is no stale-content
// failure mode.
export type GlobalEditorCwdState = {
  /** Order in which files were opened — drives EditorTabs render. */
  fileOrder: string[]
  /** Path → buffer. Path is relative to cwd (matches what
   *  ExplorerPane / EditorTabs expect). */
  openFiles: Record<string, EditorFileBuffer>
  /** Currently-active tab. null when no file is open. */
  activeFilePath: string | null
}

type GlobalEditorStore = {
  /** All cwd states keyed by absolute path. Empty when the
   *  overlay has never been opened for a given cwd. */
  byCwd: Record<string, GlobalEditorCwdState>
  /** Splitter ratio in [0.2, 0.8]. Global (not per-cwd) — feels
   *  like an IDE setting, not project-specific data. */
  splitterRatio: number
  /** Width of the in-editor file tree, in pixels. Distinct from
   *  splitterRatio (which controls editor-vs-workspace) because the
   *  file-tree pane wants a stable absolute width — narrower or
   *  wider feels off depending on the user, but the tree never
   *  wants to scale with the editor pane in a way that changes the
   *  number of visible chars per row on every workspace resize.
   *  Default 260px (matches the previous-hardcoded value); clamped
   *  in setFileTreeWidthPx to a usable range. */
  fileTreeWidthPx: number
  /** Whether the in-editor file tree is rendered at all. When
   *  false the Monaco area expands to fill the editor half of the
   *  split. Flipped by the "File Tree" palette command. Global,
   *  not per-cwd — once a user has decided they want a hidden tree
   *  they want it hidden across all projects. */
  fileTreeVisible: boolean
  aiWorkspaceId: string | null
  /** Drives the cwd→cwd transition. Most actions are keyed by
   *  cwd; this also fronts the "active cwd" so callers don't
   *  need to thread it through. */
  activeCwd: string | null
  /** ⌘P overlay. Transient UI state, global like fileTreeVisible —
   *  lives here (not uiShell) because it is editor-scoped chrome. */
  quickOpenOpen: boolean
  /** ⌘⇧F overlay. Same scoping rationale as quickOpenOpen. */
  contentSearchOpen: boolean
  /** Editor takes 100% of the workspace area; the wrapped workspace
   *  stays mounted but hidden (see GlobalEditorShell). Global, not
   *  per-cwd: fullscreen is a viewing posture, not project data. */
  editorFullscreen: boolean

  setActiveCwd: (cwd: string | null) => void
  setSplitterRatio: (ratio: number) => void
  setFileTreeWidthPx: (px: number) => void
  toggleFileTreeVisible: () => void
  setQuickOpenOpen: (open: boolean) => void
  setContentSearchOpen: (open: boolean) => void
  setEditorFullscreen: (on: boolean) => void
  toggleEditorFullscreen: () => void
  openAiWorkspace: (workspaceId: string) => void
  closeAiWorkspace: () => void

  openFile: (params: {
    cwd: string
    path: string
    text: string
    mtimeMs: number
    selection?: { line: number; column: number } | null
  }) => void
  setActiveFile: (cwd: string, path: string | null) => void
  updateFileText: (cwd: string, path: string, text: string) => void
  setFileError: (
    cwd: string,
    path: string,
    error: string | null,
    opts?: { conflict?: boolean },
  ) => void
  clearFileSelection: (cwd: string, path: string) => void
  markFileSaved: (cwd: string, path: string, text: string, mtimeMs: number) => void
  closeFile: (cwd: string, path: string, opts?: { force?: boolean }) => boolean
  /** Explorer rename support: move an open buffer to its new path,
   *  preserving dirty text. No-op when the file isn't open. */
  renameOpenFile: (cwd: string, fromPath: string, toPath: string) => void
}

// Exported because consumers (notably GlobalEditorShell's
// useShallow selector) MUST return this exact reference as the
// "no cwd active" fallback. Returning a fresh object literal from
// the selector body — { fileOrder: [], openFiles: {}, ... } — has
// a different reference every render, breaks useShallow's
// equality check, and triggers an infinite render loop that
// freezes the renderer and balloons memory.
export const EMPTY_CWD_STATE: GlobalEditorCwdState = {
  fileOrder: [],
  openFiles: {},
  activeFilePath: null,
}

function basename(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

function absolutePath(root: string, path: string): string {
  return `${root.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

function createBuffer(params: {
  root: string
  path: string
  text: string
  mtimeMs: number
  selection?: { line: number; column: number } | null
}): EditorFileBuffer {
  return makeBuffer({
    path: params.path,
    absolutePath: absolutePath(params.root, params.path),
    fileName: basename(params.path),
    text: params.text,
    mtimeMs: params.mtimeMs,
    selection: params.selection,
  })
}

// Clamp splitter ratio. 0.2 / 0.8 are picked so neither pane can
// be crushed below ~20% of the available width — at that size
// even the file tree's narrow column becomes unreadable.
const SPLITTER_MIN = 0.2
const SPLITTER_MAX = 0.8

function clampSplitter(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5
  if (ratio < SPLITTER_MIN) return SPLITTER_MIN
  if (ratio > SPLITTER_MAX) return SPLITTER_MAX
  return ratio
}

// File-tree width clamp. 180 is roughly the point where one column
// of file-name text still fits without ellipsizing every entry; 500
// is "the tree is now larger than the editor in a typical pane and
// the user is probably resizing by accident." Loosen if real usage
// shows the bounds are wrong.
const FILE_TREE_MIN_PX = 180
const FILE_TREE_MAX_PX = 500

function clampFileTreeWidth(px: number): number {
  if (!Number.isFinite(px)) return 260
  if (px < FILE_TREE_MIN_PX) return FILE_TREE_MIN_PX
  if (px > FILE_TREE_MAX_PX) return FILE_TREE_MAX_PX
  return px
}

// Geometry hydrates from the persisted snapshot at store creation —
// clamped through the same guards as live updates so a hand-edited or
// stale localStorage value can't wedge the layout. Tab rehydration is
// deliberately NOT done here: it needs disk reads (async IPC), which a
// synchronous store initializer can't await; GlobalEditorShell owns it.
const persisted = loadPersistedGlobalEditorState()

export const useGlobalEditorStore = create<GlobalEditorStore>()((set, get) => ({
  byCwd: {},
  splitterRatio: clampSplitter(persisted?.splitterRatio ?? 0.5),
  fileTreeWidthPx: clampFileTreeWidth(persisted?.fileTreeWidthPx ?? 260),
  fileTreeVisible: persisted?.fileTreeVisible ?? true,
  aiWorkspaceId: null,
  activeCwd: null,
  quickOpenOpen: false,
  contentSearchOpen: false,
  editorFullscreen: false,

  setActiveCwd: cwd => set({ activeCwd: cwd }),
  setSplitterRatio: ratio => set({ splitterRatio: clampSplitter(ratio) }),
  setFileTreeWidthPx: px => set({ fileTreeWidthPx: clampFileTreeWidth(px) }),
  toggleFileTreeVisible: () =>
    set(state => ({ fileTreeVisible: !state.fileTreeVisible })),
  setQuickOpenOpen: open => set({ quickOpenOpen: open }),
  setContentSearchOpen: open => set({ contentSearchOpen: open }),
  setEditorFullscreen: on => set({ editorFullscreen: on }),
  toggleEditorFullscreen: () =>
    set(state => ({ editorFullscreen: !state.editorFullscreen })),
  openAiWorkspace: workspaceId => set({ aiWorkspaceId: workspaceId }),
  closeAiWorkspace: () => set({ aiWorkspaceId: null }),

  openFile: ({ cwd, path, text, mtimeMs, selection }) =>
    set(state => {
      const prev = state.byCwd[cwd] ?? EMPTY_CWD_STATE
      const existing = prev.openFiles[path]
      // If the file is already open AND dirty, preserve the dirty
      // buffer (savedText becomes the new on-disk content but the
      // user-typed text stays). Otherwise replace with a fresh
      // buffer at on-disk content. Dirty preservation is what makes a
      // re-click on an already-open file (tree, rendered path,
      // quick-open) safe — it revalidates against disk without ever
      // discarding the user's unsaved edits.
      const buffer: EditorFileBuffer = existing?.dirty
        ? {
            ...existing,
            savedText: text,
            mtimeMs,
            error: null,
            conflict: false,
            selection: selection ?? existing.selection,
          }
        : createBuffer({ root: cwd, path, text, mtimeMs, selection })
      const inOrder = prev.fileOrder.includes(path)
      return {
        byCwd: {
          ...state.byCwd,
          [cwd]: {
            fileOrder: inOrder ? prev.fileOrder : [...prev.fileOrder, path],
            openFiles: { ...prev.openFiles, [path]: buffer },
            activeFilePath: path,
          },
        },
      }
    }),

  setActiveFile: (cwd, path) =>
    set(state => {
      const prev = state.byCwd[cwd]
      if (!prev) return state
      if (prev.activeFilePath === path) return state
      return {
        byCwd: {
          ...state.byCwd,
          [cwd]: { ...prev, activeFilePath: path },
        },
      }
    }),

  updateFileText: (cwd, path, text) =>
    set(state => {
      const prev = state.byCwd[cwd]
      if (!prev) return state
      const current = prev.openFiles[path]
      if (!current) return state
      return {
        byCwd: {
          ...state.byCwd,
          [cwd]: {
            ...prev,
            openFiles: {
              ...prev.openFiles,
              // Error/conflict clearing on type is part of the shared
              // transition — see withTextUpdate's WHY in bufferOps.
              [path]: withTextUpdate(current, text),
            },
          },
        },
      }
    }),

  setFileError: (cwd, path, error, opts) =>
    set(state => {
      const prev = state.byCwd[cwd]
      if (!prev) return state
      const current = prev.openFiles[path]
      if (!current) return state
      const conflict = opts?.conflict === true
      if (current.error === error && current.conflict === conflict) return state
      return {
        byCwd: {
          ...state.byCwd,
          [cwd]: {
            ...prev,
            openFiles: {
              ...prev.openFiles,
              [path]: withError(current, error, conflict),
            },
          },
        },
      }
    }),

  clearFileSelection: (cwd, path) =>
    set(state => {
      const prev = state.byCwd[cwd]
      const current = prev?.openFiles[path]
      if (!prev || !current?.selection) return state
      return {
        byCwd: {
          ...state.byCwd,
          [cwd]: {
            ...prev,
            openFiles: {
              ...prev.openFiles,
              [path]: {
                ...current,
                // WHY reveal selection is one-shot:
                // A clicked `path:line` should jump the user to that location
                // once. Keeping the selection on the durable buffer makes every
                // tab switch or Monaco remount snap back to the old clicked
                // line, overriding normal editor navigation. Cursor state is an
                // editor concern after the initial reveal, so clear the request
                // as soon as Monaco acknowledges it.
                selection: null,
              },
            },
          },
        },
      }
    }),

  markFileSaved: (cwd, path, text, mtimeMs) =>
    set(state => {
      const prev = state.byCwd[cwd]
      if (!prev) return state
      const current = prev.openFiles[path]
      if (!current) return state
      return {
        byCwd: {
          ...state.byCwd,
          [cwd]: {
            ...prev,
            openFiles: {
              ...prev.openFiles,
              [path]: withSaved(current, text, mtimeMs),
            },
          },
        },
      }
    }),

  renameOpenFile: (cwd, fromPath, toPath) =>
    set(state => {
      const prev = state.byCwd[cwd]
      const buf = prev?.openFiles[fromPath]
      if (!prev || !buf) return state
      const nextFiles = { ...prev.openFiles }
      delete nextFiles[fromPath]
      nextFiles[toPath] = {
        ...buf,
        path: toPath,
        absolutePath: absolutePath(cwd, toPath),
        language: normalizeCodeLanguage(null, basename(toPath)),
        // Rename does not touch content — dirty text rides along. mtime
        // stays valid (rename preserves it on POSIX) so the next save's
        // conflict check remains meaningful. The Monaco model is disposed
        // by the caller (its URI embeds the old path), which costs the
        // undo stack — acceptable for an explicit rename.
      }
      return {
        byCwd: {
          ...state.byCwd,
          [cwd]: {
            fileOrder: prev.fileOrder.map(p => (p === fromPath ? toPath : p)),
            openFiles: nextFiles,
            activeFilePath:
              prev.activeFilePath === fromPath ? toPath : prev.activeFilePath,
          },
        },
      }
    }),

  closeFile: (cwd, path, opts) => {
    const prev = get().byCwd[cwd]
    const current = prev?.openFiles[path]
    // Dirty-file guard: refuse to close a dirty buffer silently. The
    // caller gets a false return, shows ConfirmCloseDialog (owned by
    // EditorWorkbench), and re-calls with { force: true } if the user
    // chooses Discard. Before the dialog existed this false return was
    // silently dropped by every caller, which made dirty tabs
    // permanently uncloseable — #513 bug 1.
    if (current?.dirty && !opts?.force) return false
    set(state => {
      const cwdState = state.byCwd[cwd]
      if (!cwdState) return state
      const nextFiles = { ...cwdState.openFiles }
      delete nextFiles[path]
      const nextOrder = cwdState.fileOrder.filter(p => p !== path)
      const activeFilePath =
        cwdState.activeFilePath === path
          ? nextOrder[nextOrder.length - 1] ?? null
          : cwdState.activeFilePath
      return {
        byCwd: {
          ...state.byCwd,
          [cwd]: {
            fileOrder: nextOrder,
            openFiles: nextFiles,
            activeFilePath,
          },
        },
      }
    })
    return true
  },
}))

// Selector helper — pulls the state for the active cwd, or an
// empty placeholder when no cwd is active. Components consume this
// rather than indexing byCwd directly so they don't carry the
// "what if there's no active cwd?" branching everywhere.
export function getActiveCwdState(): {
  cwd: string | null
  state: GlobalEditorCwdState
} {
  const { activeCwd, byCwd } = useGlobalEditorStore.getState()
  return {
    cwd: activeCwd,
    state: (activeCwd && byCwd[activeCwd]) || EMPTY_CWD_STATE,
  }
}
