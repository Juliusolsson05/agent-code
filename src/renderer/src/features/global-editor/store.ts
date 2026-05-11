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
  /** Drives the cwd→cwd transition. Most actions are keyed by
   *  cwd; this also fronts the "active cwd" so callers don't
   *  need to thread it through. */
  activeCwd: string | null

  setActiveCwd: (cwd: string | null) => void
  setSplitterRatio: (ratio: number) => void

  openFile: (params: {
    cwd: string
    path: string
    text: string
    mtimeMs: number
  }) => void
  setActiveFile: (cwd: string, path: string | null) => void
  updateFileText: (cwd: string, path: string, text: string) => void
  markFileSaved: (cwd: string, path: string, text: string, mtimeMs: number) => void
  closeFile: (cwd: string, path: string) => boolean
}

const EMPTY_CWD_STATE: GlobalEditorCwdState = {
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

export const useGlobalEditorStore = create<GlobalEditorStore>()((set, get) => ({
  byCwd: {},
  splitterRatio: 0.5,
  activeCwd: null,

  setActiveCwd: cwd => set({ activeCwd: cwd }),
  setSplitterRatio: ratio => set({ splitterRatio: clampSplitter(ratio) }),

  openFile: ({ cwd, path, text, mtimeMs }) =>
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
        ? { ...existing, savedText: text, mtimeMs, error: null }
        : createBuffer({ root: cwd, path, text, mtimeMs })
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
