import { create } from 'zustand'

import { normalizeCodeLanguage } from '@shared/code/language'
import type { EditorFileBuffer } from '@renderer/features/editor/types'
import {
  hasRecoverableBufferChanges,
  makeBuffer,
  withDiskObserved,
  withDiskSnapshot,
  withError,
  withFocusRequested,
  withTextUpdate,
  withWriteAcknowledged,
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
  /** Oldest → newest workspace activation. This remains authoritative in
   * memory even when persistence retains only its last bounded slice; deriving
   * recency from object keys causes an evicted-but-live cwd to re-enter on every
   * projection. */
  cwdRecency: string[]
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
  /** Visibility is separate from identity so hiding the curated surface does
   * not unmount it and throw away unsaved buffers. */
  aiWorkspaceVisible: boolean
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
  showProjectEditor: () => void

  openFile: (params: {
    cwd: string
    path: string
    absolutePath?: string
    text: string
    mtimeMs: number
    diskVersion: string
    selection?: { line: number; column: number } | null
    /** Restoration populates tabs without cycling the active model N times. */
    activate?: boolean
    /** Explicit navigation focuses Monaco; background restoration/revalidation does not. */
    focus?: boolean
  }) => void
  setActiveFile: (
    cwd: string,
    path: string | null,
    opts?: { focus?: boolean; selection?: { line: number; column: number } },
  ) => void
  updateFileText: (cwd: string, path: string, text: string) => void
  setFileError: (
    cwd: string,
    path: string,
    error: string | null,
    opts?: {
      conflict?: boolean
      externalChange?: EditorFileBuffer['externalChange']
      generation?: number
    },
  ) => void
  clearFileSelection: (cwd: string, path: string) => void
  clearFileFocusRequest: (cwd: string, path: string) => void
  acknowledgeFileWrite: (
    cwd: string,
    path: string,
    writtenText: string,
    mtimeMs: number,
    diskVersion: string,
    generation?: number,
  ) => void
  replaceFileFromDisk: (
    cwd: string,
    path: string,
    text: string,
    mtimeMs: number,
    diskVersion: string,
    generation?: number,
  ) => void
  observeFileOnDisk: (
    cwd: string,
    path: string,
    text: string,
    mtimeMs: number,
    diskVersion: string,
    generation?: number,
  ) => void
  closeFile: (cwd: string, path: string, opts?: { force?: boolean }) => boolean
  /** Explorer rename support: move an open buffer to its new path,
   *  preserving dirty text. No-op when the file isn't open. */
  renameOpenPath: (cwd: string, fromPath: string, toPath: string) => void
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
  absolutePath?: string
  text: string
  mtimeMs: number
  diskVersion: string
  selection?: { line: number; column: number } | null
}): EditorFileBuffer {
  return makeBuffer({
    path: params.path,
    absolutePath: params.absolutePath ?? absolutePath(params.root, params.path),
    fileName: basename(params.path),
    text: params.text,
    mtimeMs: params.mtimeMs,
    diskVersion: params.diskVersion,
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
  cwdRecency: persisted?.cwdRecency ?? [],
  splitterRatio: clampSplitter(persisted?.splitterRatio ?? 0.5),
  fileTreeWidthPx: clampFileTreeWidth(persisted?.fileTreeWidthPx ?? 260),
  fileTreeVisible: persisted?.fileTreeVisible ?? true,
  aiWorkspaceId: null,
  aiWorkspaceVisible: false,
  activeCwd: null,
  quickOpenOpen: false,
  contentSearchOpen: false,
  editorFullscreen: false,

  setActiveCwd: cwd =>
    set(state => ({
      activeCwd: cwd,
      cwdRecency: cwd
        ? [...state.cwdRecency.filter(candidate => candidate !== cwd), cwd]
        : state.cwdRecency,
    })),
  setSplitterRatio: ratio => set({ splitterRatio: clampSplitter(ratio) }),
  setFileTreeWidthPx: px => set({ fileTreeWidthPx: clampFileTreeWidth(px) }),
  toggleFileTreeVisible: () => set(state => ({ fileTreeVisible: !state.fileTreeVisible })),
  setQuickOpenOpen: open => set({ quickOpenOpen: open }),
  setContentSearchOpen: open => set({ contentSearchOpen: open }),
  setEditorFullscreen: on => set({ editorFullscreen: on }),
  toggleEditorFullscreen: () => set(state => ({ editorFullscreen: !state.editorFullscreen })),
  openAiWorkspace: workspaceId => set({ aiWorkspaceId: workspaceId, aiWorkspaceVisible: true }),
  closeAiWorkspace: () => set({ aiWorkspaceVisible: false }),
  showProjectEditor: () => set({ aiWorkspaceVisible: false }),

  openFile: ({
    cwd,
    path,
    absolutePath: physicalPath,
    text,
    mtimeMs,
    diskVersion,
    selection,
    activate = true,
    focus = true,
  }) =>
    set(state => {
      const prev = state.byCwd[cwd] ?? EMPTY_CWD_STATE
      const existing = prev.openFiles[path]
      // WHY reopen is an observation, not a reload: the tree, quick-open,
      // and rendered links all reread an already-open file. Advancing a dirty
      // buffer's saved baseline here would bless an external version and let
      // the next save silently overwrite it. withDiskObserved preserves the
      // original baseline and raises a conflict instead.
      let buffer: EditorFileBuffer = existing
        ? {
            ...withDiskObserved(existing, text, mtimeMs, diskVersion),
            absolutePath: physicalPath ?? existing.absolutePath,
          }
        : createBuffer({
            root: cwd,
            path,
            absolutePath: physicalPath,
            text,
            mtimeMs,
            diskVersion,
            selection,
          })
      if (selection) buffer = { ...buffer, selection }
      if (focus) buffer = withFocusRequested(buffer)
      const inOrder = prev.fileOrder.includes(path)
      return {
        byCwd: {
          ...state.byCwd,
          [cwd]: {
            fileOrder: inOrder ? prev.fileOrder : [...prev.fileOrder, path],
            openFiles: { ...prev.openFiles, [path]: buffer },
            activeFilePath: activate ? path : prev.activeFilePath,
          },
        },
      }
    }),

  setActiveFile: (cwd, path, opts) =>
    set(state => {
      const prev = state.byCwd[cwd]
      if (!prev) return state
      if (path !== null && !prev.openFiles[path]) return state
      const current = path ? prev.openFiles[path] : null
      // Search may target text that exists only in a dirty/deleted buffer. It
      // cannot reuse openFile because that API deliberately performs a disk
      // observation, and fabricating one would clear a deletion conflict or
      // move the optimistic-save baseline. Selection therefore belongs on the
      // activation operation itself: navigate the existing lifetime without
      // claiming anything new about disk.
      let nextCurrent = current
      if (nextCurrent && opts?.selection) {
        nextCurrent = { ...nextCurrent, selection: opts.selection }
      }
      if (nextCurrent && opts?.focus) nextCurrent = withFocusRequested(nextCurrent)
      if (prev.activeFilePath === path && nextCurrent === current) return state
      return {
        byCwd: {
          ...state.byCwd,
          [cwd]: {
            ...prev,
            activeFilePath: path,
            openFiles:
              path && nextCurrent && nextCurrent !== current
                ? { ...prev.openFiles, [path]: nextCurrent }
                : prev.openFiles,
          },
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
      if (opts?.generation != null && current.generation !== opts.generation) {
        return state
      }
      const next = withError(current, error, opts?.conflict === true, opts?.externalChange)
      if (
        current.error === next.error &&
        current.conflict === next.conflict &&
        current.externalChange === next.externalChange
      ) {
        return state
      }
      return {
        byCwd: {
          ...state.byCwd,
          [cwd]: {
            ...prev,
            openFiles: {
              ...prev.openFiles,
              [path]: next,
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

  clearFileFocusRequest: (cwd, path) =>
    set(state => {
      const prev = state.byCwd[cwd]
      const current = prev?.openFiles[path]
      if (!prev || !current || current.focusRequest === null) return state
      return {
        byCwd: {
          ...state.byCwd,
          [cwd]: {
            ...prev,
            openFiles: {
              ...prev.openFiles,
              [path]: { ...current, focusRequest: null },
            },
          },
        },
      }
    }),

  acknowledgeFileWrite: (cwd, path, writtenText, mtimeMs, diskVersion, generation) =>
    set(state => {
      const prev = state.byCwd[cwd]
      if (!prev) return state
      const current = prev.openFiles[path]
      if (!current) return state
      if (generation != null && current.generation !== generation) return state
      return {
        byCwd: {
          ...state.byCwd,
          [cwd]: {
            ...prev,
            openFiles: {
              ...prev.openFiles,
              [path]: withWriteAcknowledged(current, writtenText, mtimeMs, diskVersion),
            },
          },
        },
      }
    }),

  replaceFileFromDisk: (cwd, path, text, mtimeMs, diskVersion, generation) =>
    set(state => {
      const prev = state.byCwd[cwd]
      const current = prev?.openFiles[path]
      if (!prev || !current) return state
      if (generation != null && current.generation !== generation) return state
      return {
        byCwd: {
          ...state.byCwd,
          [cwd]: {
            ...prev,
            openFiles: {
              ...prev.openFiles,
              [path]: withDiskSnapshot(current, text, mtimeMs, diskVersion),
            },
          },
        },
      }
    }),

  observeFileOnDisk: (cwd, path, text, mtimeMs, diskVersion, generation) =>
    set(state => {
      const prev = state.byCwd[cwd]
      const current = prev?.openFiles[path]
      if (!prev || !current) return state
      if (generation != null && current.generation !== generation) return state
      const next = withDiskObserved(current, text, mtimeMs, diskVersion)
      if (next === current) return state
      return {
        byCwd: {
          ...state.byCwd,
          [cwd]: {
            ...prev,
            openFiles: { ...prev.openFiles, [path]: next },
          },
        },
      }
    }),

  renameOpenPath: (cwd, fromPath, toPath) =>
    set(state => {
      const prev = state.byCwd[cwd]
      if (!prev) return state
      const affected = openPathsUnder(prev, fromPath)
      if (affected.length === 0) return state
      const affectedSet = new Set(affected)
      const nextFiles: Record<string, EditorFileBuffer> = {}
      for (const [path, buffer] of Object.entries(prev.openFiles)) {
        if (!affectedSet.has(path)) {
          nextFiles[path] = buffer
          continue
        }
        const suffix = path === fromPath ? '' : path.slice(fromPath.length)
        const nextPath = `${toPath}${suffix}`
        const normalizedAbsolute = buffer.absolutePath.replace(/\\/g, '/')
        const normalizedPath = path.replace(/\\/g, '/').replace(/^\/+/, '')
        const caseInsensitive = /^[A-Za-z]:\//.test(normalizedAbsolute)
        const comparableAbsolute = caseInsensitive
          ? normalizedAbsolute.toLowerCase()
          : normalizedAbsolute
        const comparablePath = caseInsensitive ? normalizedPath.toLowerCase() : normalizedPath
        const physicalRoot = comparableAbsolute.endsWith(`/${comparablePath}`)
          ? normalizedAbsolute.slice(0, -normalizedPath.length - 1)
          : cwd.replace(/\\/g, '/').replace(/\/+$/, '')
        nextFiles[nextPath] = {
          ...buffer,
          path: nextPath,
          // Preserve a canonical root learned from main on read. Falling back
          // to cwd is only for legacy/restored buffers that predate the
          // physical-path field; using cwd unconditionally reintroduced the
          // symlink alias immediately after an Explorer rename.
          absolutePath: absolutePath(physicalRoot, nextPath),
          // Renaming an extensionless script must retain its shebang-derived
          // language; looking at the new basename alone silently downgraded it.
          language: normalizeCodeLanguage(null, basename(nextPath), buffer.currentText),
        }
      }
      const remap = (path: string): string =>
        affectedSet.has(path)
          ? `${toPath}${path === fromPath ? '' : path.slice(fromPath.length)}`
          : path
      return {
        byCwd: {
          ...state.byCwd,
          [cwd]: {
            // A main-process no-clobber rename makes collisions impossible,
            // but Set keeps stale duplicate state from surviving forever.
            fileOrder: [...new Set(prev.fileOrder.map(remap))],
            openFiles: nextFiles,
            activeFilePath: prev.activeFilePath ? remap(prev.activeFilePath) : null,
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
    if (current && hasRecoverableBufferChanges(current) && !opts?.force) return false
    set(state => {
      const cwdState = state.byCwd[cwd]
      if (!cwdState) return state
      const nextFiles = { ...cwdState.openFiles }
      delete nextFiles[path]
      const closedIndex = cwdState.fileOrder.indexOf(path)
      const nextOrder = cwdState.fileOrder.filter(p => p !== path)
      const activeFilePath =
        cwdState.activeFilePath === path
          ? (nextOrder[Math.min(closedIndex, nextOrder.length - 1)] ?? null)
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

/** Exact file or every open descendant of a directory-like path. This pure
 * helper is shared by preflight (dirty confirmation/model disposal) and the
 * atomic store transition so those two layers cannot disagree on scope. */
export function openPathsUnder(
  state: Pick<GlobalEditorCwdState, 'fileOrder'>,
  path: string,
): string[] {
  const prefix = path.endsWith('/') ? path : `${path}/`
  return state.fileOrder.filter(candidate => candidate === path || candidate.startsWith(prefix))
}

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
