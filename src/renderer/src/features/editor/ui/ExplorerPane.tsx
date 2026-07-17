import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { basename, dirname } from '@renderer/features/editor/lib/path'
import { FileIcon, FolderIcon } from '@renderer/features/editor/lib/fileIcon'
// Shared editor FS contract — was a local duplicate of the main/preload entry
// shape. See @shared/types/editorFs.
import type { EditorFsEntry } from '@shared/types/editorFs'

type TreeNode = {
  entry: EditorFsEntry
  children: EditorFsEntry[] | null
  loading: boolean
  error: string | null
}

// Context menu state. `entry: null` = the root-header menu (New File /
// New Folder against the project root).
type MenuState = { x: number; y: number; entry: EditorFsEntry | null } | null

// Inline edit rows for create/rename. Rendered in-tree (an input row
// under the parent) instead of a modal: the user's eyes are already on
// the spot in the tree where the result will appear, and in-place editing
// is what every real file explorer trains people to expect.
type EditState =
  | { kind: 'create-file' | 'create-dir'; parentPath: string; draft: string }
  | { kind: 'rename'; entry: EditorFsEntry; draft: string }
  | null

function validateBasename(name: string): string | null {
  if (!name) return 'Enter a name.'
  if (name === '.' || name === '..') return 'Use a file or folder name.'
  if (/[\\/]/.test(name)) return 'Names cannot contain path separators.'
  if (/\0|[\u0001-\u001f\u007f]/.test(name)) {
    return 'Names cannot contain control characters.'
  }
  // These characters are rejected on Windows and are surprising portability
  // hazards even when the current workspace happens to be on macOS/Linux.
  if (/[<>:"|?*]/.test(name) || /[. ]$/.test(name)) {
    return 'That name is not portable across supported platforms.'
  }
  return null
}

function clampedMenu(x: number, y: number, entry: EditorFsEntry | null): Exclude<MenuState, null> {
  const viewportWidth = typeof window === 'undefined' ? x + 180 : window.innerWidth
  const viewportHeight = typeof window === 'undefined' ? y + 180 : window.innerHeight
  return {
    x: Math.max(4, Math.min(x, viewportWidth - 180)),
    y: Math.max(4, Math.min(y, viewportHeight - 180)),
    entry,
  }
}

function visibleTreePaths(
  entries: readonly EditorFsEntry[],
  nodes: Readonly<Record<string, TreeNode>>,
  expanded: ReadonlySet<string>,
  out: string[] = [],
): string[] {
  for (const entry of entries) {
    out.push(entry.path)
    if (entry.isDirectory && expanded.has(entry.path)) {
      visibleTreePaths(nodes[entry.path]?.children ?? [], nodes, expanded, out)
    }
  }
  return out
}

type Props = {
  root: string
  activeFilePath: string | null
  onOpenFile: (path: string) => void
  /** Buffer fix-ups for the host: a renamed/deleted file may be open as a
   *  tab; the host owns that state (and the Monaco model registry). */
  onFileRenamed?: (fromPath: string, toPath: string) => void
  onFileDeleted?: (path: string) => void
  /** A disk destination can be absent while a deleted-but-still-open buffer
   * owns the same logical path. Let the host reject that model collision
   * before main performs the otherwise-valid no-clobber rename. */
  onBeforeRename?: (fromPath: string, toPath: string) => boolean | Promise<boolean>
  /** Must resolve before disk deletion; hosts use it to confirm dirty tabs. */
  onBeforeDelete?: (path: string) => Promise<boolean>
}

export function ExplorerPane({
  root,
  activeFilePath,
  onOpenFile,
  onFileRenamed,
  onFileDeleted,
  onBeforeRename,
  onBeforeDelete,
}: Props) {
  const [nodes, setNodes] = useState<Record<string, TreeNode>>({})
  const [rootEntries, setRootEntries] = useState<EditorFsEntry[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']))
  const [error, setError] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [mutationPending, setMutationPending] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  // Reveals dotfiles AND the main-side junk filter in one toggle — the
  // editor-fs contract is "showHidden means the tree never lies".
  const [showHidden, setShowHidden] = useState(false)
  const [menu, setMenu] = useState<MenuState>(null)
  const [edit, setEdit] = useState<EditState>(null)
  const [focusedTreePath, setFocusedTreePath] = useState<string | null>(null)
  // Two-step in-menu delete confirm (first click arms, second executes)
  // instead of a modal: deletion from a context menu is already a
  // deliberate two-gesture act, and the workbench modal slot is owned by
  // the dirty-close dialog.
  const [armedDelete, setArmedDelete] = useState<string | null>(null)
  const inFlightLoadsRef = useRef<Map<string, number>>(new Map())
  const queuedLoadsRef = useRef<Set<string>>(new Set())
  const loadGenerationRef = useRef(0)
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuInvokerRef = useRef<HTMLElement | null>(null)

  const loadDirectory = useCallback(
    async (path: string) => {
      const generation = loadGenerationRef.current
      if (inFlightLoadsRef.current.has(path)) {
        // A mutation can finish while the same directory is already loading.
        // Dropping that second request leaves the tree showing the pre-mutation
        // snapshot indefinitely, so coalesce it into exactly one trailing read.
        queuedLoadsRef.current.add(path)
        return
      }
      inFlightLoadsRef.current.set(path, generation)
      setNodes(prev => {
        const current = prev[path]
        if (!current) return prev
        return { ...prev, [path]: { ...current, loading: true, error: null } }
      })
      try {
        const result = await window.api.editorListDirectory({
          root,
          path,
          showHidden,
        })
        if (generation !== loadGenerationRef.current) return
        if (!result.ok) {
          if (path === '') setError(result.error)
          setNodes(prev => {
            const current = prev[path]
            if (!current) return prev
            return {
              ...prev,
              [path]: { ...current, loading: false, error: result.error },
            }
          })
          return
        }
        if (path === '') {
          setRootEntries(result.entries)
          setError(null)
        }
        setNodes(prev => {
          const current = prev[path]
          if (!current) return prev
          return {
            ...prev,
            [path]: {
              ...current,
              children: result.entries,
              loading: false,
              error: null,
            },
          }
        })
      } catch (err) {
        if (generation !== loadGenerationRef.current) return
        const message = err instanceof Error ? err.message : 'Failed to read directory.'
        if (path === '') setError(message)
        setNodes(prev => {
          const current = prev[path]
          if (!current) return prev
          return {
            ...prev,
            [path]: { ...current, loading: false, error: message },
          }
        })
      } finally {
        if (inFlightLoadsRef.current.get(path) === generation) {
          inFlightLoadsRef.current.delete(path)
          if (queuedLoadsRef.current.delete(path)) {
            queueMicrotask(() => void loadDirectory(path))
          }
        }
      }
    },
    [root, showHidden],
  )

  useEffect(() => {
    loadGenerationRef.current += 1
    inFlightLoadsRef.current.clear()
    queuedLoadsRef.current.clear()
    setNodes({
      '': {
        entry: {
          name: basename(root),
          path: '',
          isDirectory: true,
          size: null,
          mtimeMs: 0,
        },
        children: null,
        loading: true,
        error: null,
      },
    })
    setRootEntries([])
    setExpanded(new Set(['']))
    setEdit(null)
    setMenu(null)
    void loadDirectory('')
    // loadDirectory changes when showHidden flips, but that toggle refreshes
    // expanded directories below. Resetting here would collapse the entire
    // user's navigation context just for revealing dotfiles.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root])

  const previousShowHiddenRef = useRef(showHidden)
  useEffect(() => {
    // loadDirectory also changes identity when root changes. Only the hidden-
    // file preference should run this expanded-branch refresh; the root effect
    // owns root transitions and resets their navigation graph atomically.
    if (previousShowHiddenRef.current === showHidden) return
    previousShowHiddenRef.current = showHidden
    loadGenerationRef.current += 1
      inFlightLoadsRef.current.clear()
      queuedLoadsRef.current.clear()
    for (const path of expandedRef.current) void loadDirectory(path)
  }, [loadDirectory, showHidden])

  // Dismiss the context menu on any outside interaction. Capture-phase so
  // a click that lands on another menu trigger still closes this menu
  // first instead of stacking two.
  useEffect(() => {
    if (!menu) return
    const dismiss = () => {
      setMenu(null)
      setArmedDelete(null)
    }
    const closeOnMouseDown = (event: MouseEvent) => {
      if (event && menuRef.current?.contains(event.target as Node)) return
      dismiss()
    }
    window.addEventListener('mousedown', closeOnMouseDown, true)
    window.addEventListener('blur', dismiss)
    return () => {
      window.removeEventListener('mousedown', closeOnMouseDown, true)
      window.removeEventListener('blur', dismiss)
    }
  }, [menu])

  const ensureNode = useCallback((entry: EditorFsEntry) => {
    setNodes(prev => {
      if (prev[entry.path]) return prev
      return {
        ...prev,
        [entry.path]: {
          entry,
          children: null,
          loading: false,
          error: null,
        },
      }
    })
  }, [])

  const toggleDirectory = useCallback(
    (entry: EditorFsEntry) => {
      ensureNode(entry)
      setExpanded(prev => {
        const next = new Set(prev)
        if (next.has(entry.path)) {
          next.delete(entry.path)
          return next
        }
        next.add(entry.path)
        return next
      })
      const node = nodes[entry.path]
      if (!node?.children && !node?.loading && !inFlightLoadsRef.current.has(entry.path)) {
        void loadDirectory(entry.path)
      }
    },
    [ensureNode, loadDirectory, nodes],
  )

  // ── Mutations (create / rename / delete) ──────────────────────────
  // All go through the editor-fs IPC (root-contained in main); the tree
  // reloads the affected parent instead of optimistically patching state
  // so what's shown is always what a real readdir returned.

  const beginCreate = useCallback(
    (kind: 'create-file' | 'create-dir', target: EditorFsEntry | null) => {
      const parentPath = target ? (target.isDirectory ? target.path : dirname(target.path)) : ''
      if (target?.isDirectory) {
        // Creating inside a collapsed folder would put the input row in
        // an invisible subtree — expand first.
        ensureNode(target)
        setExpanded(prev => new Set(prev).add(target.path))
        if (!nodes[target.path]?.children) void loadDirectory(target.path)
      }
      setMenu(null)
      setEditError(null)
      setEdit({ kind, parentPath, draft: '' })
    },
    [ensureNode, loadDirectory, nodes],
  )

  const commitCreate = useCallback(async () => {
    if (!edit || edit.kind === 'rename' || mutationPending) return
    const name = edit.draft.trim()
    const invalid = validateBasename(name)
    if (invalid) {
      setEditError(invalid)
      return
    }
    const path = edit.parentPath ? `${edit.parentPath}/${name}` : name
    setMutationPending(true)
    try {
      const result = await (
        edit.kind === 'create-file'
          ? window.api.editorCreateFile({ root, path })
          : window.api.editorCreateDirectory({ root, path })
      ).catch(err => ({
        ok: false as const,
        error: err instanceof Error ? err.message : 'Failed to create item.',
      }))
      if (!result.ok) {
        setMutationError(result.error)
        return
      }
      setEdit(null)
      setEditError(null)
      setMutationError(null)
      await loadDirectory(edit.parentPath)
      if (edit.kind === 'create-file') onOpenFile(result.path)
    } finally {
      setMutationPending(false)
    }
  }, [edit, loadDirectory, mutationPending, onOpenFile, root])

  const commitRename = useCallback(async () => {
    if (!edit || edit.kind !== 'rename' || mutationPending) return
    const newName = edit.draft.trim()
    const entry = edit.entry
    if (newName === entry.name) {
      setEdit(null)
      setEditError(null)
      return
    }
    const invalid = validateBasename(newName)
    if (invalid) {
      setEditError(invalid)
      return
    }
    const parent = dirname(entry.path)
    const toPath = parent ? `${parent}/${newName}` : newName
    setMutationPending(true)
    try {
      if (onBeforeRename && !(await onBeforeRename(entry.path, toPath))) {
        setMutationError('Close the open tab already using the rename destination, then retry.')
        return
      }
      const result = await window.api
        .editorRename({
          root,
          fromPath: entry.path,
          toPath,
        })
        .catch(err => ({
          ok: false as const,
          error: err instanceof Error ? err.message : 'Failed to rename item.',
        }))
      if (!result.ok) {
        setMutationError(result.error)
        return
      }
      setEdit(null)
      setEditError(null)
      setMutationError(null)
      // Remap buffers immediately after disk success, before any awaited tree
      // refresh. Chokidar can report the old path as unlinked during that wait;
      // delaying this callback let a synthetic deletion conflict hitchhike onto
      // the newly renamed buffer.
      onFileRenamed?.(entry.path, result.path)
      await loadDirectory(parent)
    } catch (err) {
      setMutationError(err instanceof Error ? err.message : 'Failed to validate rename.')
    } finally {
      setMutationPending(false)
    }
  }, [edit, loadDirectory, mutationPending, onBeforeRename, onFileRenamed, root])

  const commitDelete = useCallback(
    async (entry: EditorFsEntry) => {
      if (mutationPending) return
      setMenu(null)
      setArmedDelete(null)
      setMutationPending(true)
      try {
        if (onBeforeDelete && !(await onBeforeDelete(entry.path))) return
        const result = await window.api.editorDelete({ root, path: entry.path }).catch(err => ({
          ok: false as const,
          error: err instanceof Error ? err.message : 'Failed to delete item.',
        }))
        if (!result.ok) {
          setMutationError(result.error)
          return
        }
        setMutationError(null)
        await loadDirectory(dirname(entry.path))
        onFileDeleted?.(entry.path)
      } catch (err) {
        setMutationError(err instanceof Error ? err.message : 'Failed to confirm deletion.')
      } finally {
        setMutationPending(false)
      }
    },
    [loadDirectory, mutationPending, onBeforeDelete, onFileDeleted, root],
  )

  const rootNode = nodes['']
  const entries = rootNode?.children ?? rootEntries
  const visiblePaths = useMemo(
    () => visibleTreePaths(entries, nodes, expanded),
    [entries, expanded, nodes],
  )
  const visiblePathSet = useMemo(() => new Set(visiblePaths), [visiblePaths])
  // Focus state can name a row that was renamed, deleted, hidden, or collapsed.
  // Derive the actual tab stop from the rendered tree every time so one stale
  // string can never make all treeitems tabIndex=-1.
  const treeTabStopPath =
    (focusedTreePath && visiblePathSet.has(focusedTreePath) ? focusedTreePath : null) ??
    (activeFilePath && visiblePathSet.has(activeFilePath) ? activeFilePath : null) ??
    visiblePaths[0] ??
    null

  const activeParents = useMemo(() => {
    const out = new Set<string>()
    let current = activeFilePath ? dirname(activeFilePath) : ''
    while (current) {
      out.add(current)
      current = dirname(current)
    }
    out.add('')
    return out
  }, [activeFilePath])

  useEffect(() => {
    if (!activeFilePath) return
    const parents = [...activeParents].filter(Boolean)
    if (parents.length === 0) return
    setExpanded(prev => {
      const next = new Set(prev)
      for (const path of parents) next.add(path)
      return next
    })
    setNodes(prev => {
      const next = { ...prev }
      for (const path of parents) {
        if (next[path]) continue
        next[path] = {
          entry: {
            name: basename(path),
            path,
            isDirectory: true,
            size: null,
            mtimeMs: 0,
          },
          children: null,
          loading: false,
          error: null,
        }
      }
      return next
    })
    // Quick Open/search navigation can land in an unloaded branch. Loading
    // every ancestor reveals the selected file without requiring the user to
    // manually retrace its path through the tree.
    for (const path of parents) void loadDirectory(path)
  }, [activeFilePath, activeParents, loadDirectory])

  return (
    <aside className="relative flex h-full min-h-0 w-full flex-shrink-0 flex-col border-r border-border bg-surface font-code text-[12px]">
      <div
        className="flex h-8 flex-shrink-0 items-center justify-between border-b border-border px-2 text-[10px] uppercase tracking-wider text-muted"
        title={root}
        onContextMenu={event => {
          event.preventDefault()
          menuInvokerRef.current = null
          setMenu(clampedMenu(event.clientX, event.clientY, null))
        }}
      >
        <span className="truncate">{basename(root)}</span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            title="Refresh explorer"
            aria-label="Refresh explorer"
            onClick={() => {
      loadGenerationRef.current += 1
      inFlightLoadsRef.current.clear()
      queuedLoadsRef.current.clear()
              for (const path of expandedRef.current) void loadDirectory(path)
            }}
            className="flex h-5 w-5 items-center justify-center rounded text-muted hover:bg-surface-hi hover:text-ink"
          >
            ↻
          </button>
          <button
            type="button"
            title={showHidden ? 'Hide hidden files' : 'Show hidden files'}
            aria-label={showHidden ? 'Hide hidden files' : 'Show hidden files'}
            onClick={() => setShowHidden(prev => !prev)}
            className={`flex h-5 w-5 items-center justify-center rounded hover:bg-surface-hi ${
              showHidden ? 'text-ink' : 'text-muted hover:text-ink'
            }`}
          >
            •
          </button>
          <button
            type="button"
            title="New file / folder"
            aria-label="New file or folder"
            onClick={event => {
              event.stopPropagation()
              menuInvokerRef.current = event.currentTarget
              setMenu(clampedMenu(event.clientX, event.clientY, null))
            }}
            className="flex h-5 w-5 items-center justify-center rounded text-muted hover:bg-surface-hi hover:text-ink"
          >
            +
          </button>
        </span>
      </div>
      {mutationError && (
        <div
          role="alert"
          className="flex items-start gap-2 border-b border-border bg-danger/10 px-2 py-1 text-[10px] text-danger"
        >
          <span className="min-w-0 flex-1 break-words">{mutationError}</span>
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={() => setMutationError(null)}
            className="text-muted hover:text-ink"
          >
            ×
          </button>
        </div>
      )}
      <div
        role="tree"
        aria-label="Project files"
        aria-busy={rootNode?.loading || undefined}
        className="min-h-0 flex-1 overflow-auto py-1"
      >
        {error ? (
          <div className="px-2 py-1 text-danger">{error}</div>
        ) : (
          <>
            {edit && edit.kind !== 'rename' && edit.parentPath === '' && (
              <InlineEditRow
                depth={0}
                placeholder={edit.kind === 'create-file' ? 'new-file.ts' : 'new-folder'}
                value={edit.draft}
                error={editError}
                disabled={mutationPending}
                onChange={draft => setEdit(prev => (prev ? { ...prev, draft } : prev))}
                onCommit={() => void commitCreate()}
                onCancel={() => setEdit(null)}
              />
            )}
            <TreeEntries
              entries={entries}
              nodes={nodes}
              expanded={expanded}
              activeFilePath={activeFilePath}
              activeParents={activeParents}
              tabStopPath={treeTabStopPath}
              depth={0}
              edit={edit}
              editError={editError}
              editDisabled={mutationPending}
              onOpenFile={onOpenFile}
              onToggleDirectory={toggleDirectory}
              onTreeFocus={setFocusedTreePath}
              onContextMenu={(entry, x, y, invoker) => {
                menuInvokerRef.current = invoker
                setArmedDelete(null)
                setMenu(clampedMenu(x, y, entry))
              }}
              onEditChange={draft => setEdit(prev => (prev ? { ...prev, draft } : prev))}
              onEditCommit={() => {
                if (!edit) return
                if (edit.kind === 'rename') void commitRename()
                else void commitCreate()
              }}
              onEditCancel={() => setEdit(null)}
            />
          </>
        )}
        {!error && !rootNode?.loading && entries.length === 0 && !edit ? (
          <p role="status" className="px-2 py-2 text-[10px] text-muted">
            This folder is empty.
          </p>
        ) : null}
        {!error && rootNode?.loading ? (
          <p role="status" aria-live="polite" className="px-2 py-2 text-[10px] text-muted">
            Loading project files…
          </p>
        ) : null}
      </div>
      {menu && (
        // mousedown on the menu itself must not bubble to the window
        // capture listener that closes the menu.
        <div
          ref={menuRef}
          role="menu"
          aria-label={menu.entry ? `Actions for ${menu.entry.name}` : 'Explorer actions'}
          className="fixed z-30 min-w-[160px] rounded border border-border bg-surface py-1 shadow-lg"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={event => event.stopPropagation()}
          onKeyDown={event => {
            if (event.key === 'Escape') {
              event.preventDefault()
              setMenu(null)
              requestAnimationFrame(() => menuInvokerRef.current?.focus())
              return
            }
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            const items = [
              ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
            ]
            const current = items.indexOf(document.activeElement as HTMLButtonElement)
            const direction = event.key === 'ArrowDown' ? 1 : -1
            items[(current + direction + items.length) % items.length]?.focus()
          }}
        >
          <MenuItem
            label="New File"
            autoFocus
            onClick={() => beginCreate('create-file', menu.entry)}
          />
          <MenuItem label="New Folder" onClick={() => beginCreate('create-dir', menu.entry)} />
          {menu.entry && (
            <>
              <div className="mx-2 my-1 border-t border-border" />
              <MenuItem
                label="Rename"
                onClick={() => {
                  const entry = menu.entry
                  if (!entry) return
                  setMenu(null)
                  setEdit({ kind: 'rename', entry, draft: entry.name })
                }}
              />
              <MenuItem
                label={armedDelete === menu.entry.path ? 'Delete — click to confirm' : 'Delete'}
                danger
                onClick={() => {
                  const entry = menu.entry
                  if (!entry) return
                  if (armedDelete === entry.path) void commitDelete(entry)
                  else setArmedDelete(entry.path)
                }}
              />
            </>
          )}
        </div>
      )}
    </aside>
  )
}

function MenuItem({
  label,
  danger = false,
  autoFocus = false,
  onClick,
}: {
  label: string
  danger?: boolean
  autoFocus?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      autoFocus={autoFocus}
      onClick={onClick}
      className={`flex w-full items-center px-3 py-1 text-left text-[11px] hover:bg-surface-hi ${
        danger ? 'text-danger' : 'text-ink-dim hover:text-ink'
      }`}
    >
      {label}
    </button>
  )
}

function InlineEditRow({
  depth,
  placeholder,
  value,
  error,
  disabled = false,
  onChange,
  onCommit,
  onCancel,
}: {
  depth: number
  placeholder: string
  value: string
  error?: string | null
  disabled?: boolean
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  return (
    <div
      className="flex min-h-[22px] flex-col justify-center pr-2"
      style={{ paddingLeft: 21 + depth * 12 }}
    >
      <input
        autoFocus
        readOnly={disabled}
        aria-busy={disabled || undefined}
        value={value}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'explorer-inline-edit-error' : undefined}
        placeholder={placeholder}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') onCommit()
          if (event.key === 'Escape') onCancel()
        }}
        onBlur={() => {
          if (!disabled) onCancel()
        }}
        className="w-full rounded border border-border-hi bg-canvas px-1 py-0.5 text-[11px] text-ink outline-none"
      />
      {error ? (
        <span id="explorer-inline-edit-error" className="py-0.5 text-[9px] text-danger">
          {error}
        </span>
      ) : null}
    </div>
  )
}

function TreeEntries({
  entries,
  nodes,
  expanded,
  activeFilePath,
  activeParents,
  tabStopPath,
  depth,
  edit,
  editError,
  editDisabled,
  onOpenFile,
  onToggleDirectory,
  onTreeFocus,
  onContextMenu,
  onEditChange,
  onEditCommit,
  onEditCancel,
}: {
  entries: EditorFsEntry[]
  nodes: Record<string, TreeNode>
  expanded: Set<string>
  activeFilePath: string | null
  activeParents: Set<string>
  tabStopPath: string | null
  depth: number
  edit: EditState
  editError: string | null
  editDisabled: boolean
  onOpenFile: (path: string) => void
  onToggleDirectory: (entry: EditorFsEntry) => void
  onTreeFocus: (path: string) => void
  onContextMenu: (
    entry: EditorFsEntry,
    x: number,
    y: number,
    invoker: HTMLButtonElement,
  ) => void
  onEditChange: (draft: string) => void
  onEditCommit: () => void
  onEditCancel: () => void
}) {
  return (
    <>
      {entries.map(entry => {
        const node = nodes[entry.path]
        const isExpanded = expanded.has(entry.path)
        const isActive = activeFilePath === entry.path
        const isActiveParent = activeParents.has(entry.path)
        const isRenaming = edit?.kind === 'rename' && edit.entry.path === entry.path
        // WHY a constant-width caret column instead of injecting glyphs:
        //   keeps file-icon X positions aligned across files and folders so
        //   the eye can scan the column without zig-zag indentation.
        const rowStyle = { paddingLeft: 6 + depth * 12 }
        return (
          <div key={entry.path || entry.name}>
            {isRenaming && edit ? (
              <InlineEditRow
                depth={depth}
                placeholder={entry.name}
                value={edit.draft}
                error={editError}
                disabled={editDisabled}
                onChange={onEditChange}
                onCommit={onEditCommit}
                onCancel={onEditCancel}
              />
            ) : (
              <button
                type="button"
                role="treeitem"
                tabIndex={tabStopPath === entry.path ? 0 : -1}
                aria-level={depth + 1}
                aria-selected={isActive}
                aria-expanded={entry.isDirectory ? isExpanded : undefined}
                onClick={() =>
                  entry.isDirectory ? onToggleDirectory(entry) : onOpenFile(entry.path)
                }
                onFocus={() => onTreeFocus(entry.path)}
                onKeyDown={event => {
                  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                    event.preventDefault()
                    const rect = event.currentTarget.getBoundingClientRect()
                    onContextMenu(
                      entry,
                      rect.left + Math.min(rect.width, 24),
                      rect.top + Math.min(rect.height, 20),
                      event.currentTarget,
                    )
                    return
                  }
                  const items = [
                    ...(event.currentTarget
                      .closest('[role="tree"]')
                      ?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]') ?? []),
                  ]
                  const currentIndex = items.indexOf(event.currentTarget)
                  let focusIndex: number | null = null
                  if (event.key === 'ArrowDown') focusIndex = currentIndex + 1
                  if (event.key === 'ArrowUp') focusIndex = currentIndex - 1
                  if (event.key === 'Home') focusIndex = 0
                  if (event.key === 'End') focusIndex = items.length - 1
                  if (event.key === 'ArrowRight' && entry.isDirectory) {
                    if (!isExpanded) onToggleDirectory(entry)
                    else focusIndex = currentIndex + 1
                  }
                  if (event.key === 'ArrowLeft') {
                    if (entry.isDirectory && isExpanded) {
                      onToggleDirectory(entry)
                    } else {
                      const parentPath = dirname(entry.path)
                      focusIndex = items.findIndex(item => item.dataset.treePath === parentPath)
                    }
                  }
                  if (focusIndex === null) return
                  event.preventDefault()
                  items[Math.max(0, Math.min(focusIndex, items.length - 1))]?.focus()
                }}
                onContextMenu={event => {
                  event.preventDefault()
                  event.stopPropagation()
                  onContextMenu(entry, event.clientX, event.clientY, event.currentTarget)
                }}
                data-tree-path={entry.path}
                className={`group flex h-[22px] w-full items-center gap-1.5 pr-2 text-left transition-colors ${
                  isActive
                    ? 'bg-accent-soft text-ink'
                    : isActiveParent
                      ? 'text-ink hover:bg-surface-hi'
                      : 'text-ink-dim hover:bg-surface-hi hover:text-ink'
                }`}
                style={rowStyle}
                title={entry.path}
              >
                <span className="flex w-3 flex-shrink-0 items-center justify-center text-[10px] text-muted">
                  {entry.isDirectory ? (isExpanded ? '▾' : '▸') : ''}
                </span>
                <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
                  {entry.isDirectory ? (
                    <FolderIcon name={entry.name} open={isExpanded} />
                  ) : (
                    <FileIcon name={entry.name} />
                  )}
                </span>
                <span className="truncate">{entry.name}</span>
              </button>
            )}
            {entry.isDirectory && isExpanded && (
              <div role="group">
                {edit && edit.kind !== 'rename' && edit.parentPath === entry.path && (
                  <InlineEditRow
                    depth={depth + 1}
                    placeholder={edit.kind === 'create-file' ? 'new-file.ts' : 'new-folder'}
                    value={edit.draft}
                    error={editError}
                    disabled={editDisabled}
                    onChange={onEditChange}
                    onCommit={onEditCommit}
                    onCancel={onEditCancel}
                  />
                )}
                {node?.loading ? (
                  <div
                    className="py-0.5 text-[10px] text-muted"
                    style={{ paddingLeft: 28 + depth * 12 }}
                  >
                    loading…
                  </div>
                ) : node?.error ? (
                  <div
                    className="py-0.5 text-[10px] text-danger"
                    style={{ paddingLeft: 28 + depth * 12 }}
                  >
                    {node.error}
                  </div>
                ) : (
                  <TreeEntries
                    entries={node?.children ?? []}
                    nodes={nodes}
                    expanded={expanded}
                    activeFilePath={activeFilePath}
                    activeParents={activeParents}
                    tabStopPath={tabStopPath}
                    depth={depth + 1}
                    edit={edit}
                    editError={editError}
                    editDisabled={editDisabled}
                    onOpenFile={onOpenFile}
                    onToggleDirectory={onToggleDirectory}
                    onTreeFocus={onTreeFocus}
                    onContextMenu={onContextMenu}
                    onEditChange={onEditChange}
                    onEditCommit={onEditCommit}
                    onEditCancel={onEditCancel}
                  />
                )}
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}
