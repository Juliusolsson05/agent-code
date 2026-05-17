import { create } from 'zustand'

import { normalizeCodeLanguage } from '@shared/code/language'
import type { EditorFileBuffer } from '@renderer/features/editor/types'

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
// WHY a separate store rather than reusing useEditorStore:
// useEditorStore (in features/editor/store.ts) is the
// single-workspace store from the prior "Code Editor" mode
// (feat/code-editor). Its `enterEditor` action explicitly clears
// open buffers when projectRoot changes — the opposite of what
// Global Editor needs. Trying to extend that store with per-cwd
// memory would tangle two distinct lifecycles. A separate store
// keeps the prior mode's semantics intact while letting Global
// Editor own its own per-cwd memory model.
//
// WHY in-memory only (no disk persistence): cc-shell already
// persists session metadata, tab layouts, ghost logs, debug
// bundles, perf telemetry. Adding ANOTHER persistence channel
// for editor draft state — including potentially-sensitive
// file contents that haven't been saved — is risk per
// session-respawn-oom-root-cause.md's "every persistence path is
// a potential leak" pattern. Restart wipes the buffer; if the
// user has unsaved work they save before quitting. Disk
// persistence is a follow-up if we feel the friction.
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

  setActiveCwd: (cwd: string | null) => void
  setSplitterRatio: (ratio: number) => void
  setFileTreeWidthPx: (px: number) => void
  toggleFileTreeVisible: () => void
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
  clearFileSelection: (cwd: string, path: string) => void
  markFileSaved: (cwd: string, path: string, text: string, mtimeMs: number) => void
  closeFile: (cwd: string, path: string) => boolean
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
  return {
    path: params.path,
    absolutePath: absolutePath(params.root, params.path),
    language: normalizeCodeLanguage(null, basename(params.path)),
    savedText: params.text,
    currentText: params.text,
    dirty: false,
    loading: false,
    error: null,
    mtimeMs: params.mtimeMs,
    selection: params.selection ?? null,
  }
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

export const useGlobalEditorStore = create<GlobalEditorStore>()((set, get) => ({
  byCwd: {},
  splitterRatio: 0.5,
  fileTreeWidthPx: 260,
  fileTreeVisible: true,
  aiWorkspaceId: null,
  activeCwd: null,

  setActiveCwd: cwd => set({ activeCwd: cwd }),
  setSplitterRatio: ratio => set({ splitterRatio: clampSplitter(ratio) }),
  setFileTreeWidthPx: px => set({ fileTreeWidthPx: clampFileTreeWidth(px) }),
  toggleFileTreeVisible: () =>
    set(state => ({ fileTreeVisible: !state.fileTreeVisible })),
  openAiWorkspace: workspaceId => set({ aiWorkspaceId: workspaceId }),
  closeAiWorkspace: () => set({ aiWorkspaceId: null }),

  openFile: ({ cwd, path, text, mtimeMs, selection }) =>
    set(state => {
      const prev = state.byCwd[cwd] ?? EMPTY_CWD_STATE
      const existing = prev.openFiles[path]
      // If the file is already open AND dirty, preserve the dirty
      // buffer (savedText becomes the new on-disk content but the
      // user-typed text stays). Otherwise replace with a fresh
      // buffer at on-disk content. This mirrors the prior
      // useEditorStore semantics so behaviour is consistent
      // between Global Editor and the "Code Editor" mode.
      const buffer: EditorFileBuffer = existing?.dirty
        ? {
            ...existing,
            savedText: text,
            mtimeMs,
            error: null,
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
              [path]: {
                ...current,
                currentText: text,
                dirty: text !== current.savedText,
              },
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
              [path]: {
                ...current,
                savedText: text,
                currentText: text,
                dirty: false,
                mtimeMs,
                error: null,
              },
            },
          },
        },
      }
    }),

  closeFile: (cwd, path) => {
    const prev = get().byCwd[cwd]
    const current = prev?.openFiles[path]
    // Dirty-file guard: same contract as useEditorStore — refuse
    // to close a dirty buffer silently. Caller (the tab close
    // button) gets a false return and decides whether to surface
    // a confirm prompt.
    if (current?.dirty) return false
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
