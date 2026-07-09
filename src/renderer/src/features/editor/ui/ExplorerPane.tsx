import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
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

type Props = {
  root: string
  activeFilePath: string | null
  onOpenFile: (path: string) => void
  /** Buffer fix-ups for the host: a renamed/deleted file may be open as a
   *  tab; the host owns that state (and the Monaco model registry). */
  onFileRenamed?: (fromPath: string, toPath: string) => void
  onFileDeleted?: (path: string) => void
}

export function ExplorerPane({
  root,
  activeFilePath,
  onOpenFile,
  onFileRenamed,
  onFileDeleted,
}: Props) {
  const [nodes, setNodes] = useState<Record<string, TreeNode>>({})
  const [rootEntries, setRootEntries] = useState<EditorFsEntry[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']))
  const [error, setError] = useState<string | null>(null)
  // Reveals dotfiles AND the main-side junk filter in one toggle — the
  // editor-fs contract is "showHidden means the tree never lies".
  const [showHidden, setShowHidden] = useState(false)
  const [menu, setMenu] = useState<MenuState>(null)
  const [edit, setEdit] = useState<EditState>(null)
  // Two-step in-menu delete confirm (first click arms, second executes)
  // instead of a modal: deletion from a context menu is already a
  // deliberate two-gesture act, and the workbench modal slot is owned by
  // the dirty-close dialog.
  const [armedDelete, setArmedDelete] = useState<string | null>(null)
  const inFlightLoadsRef = useRef<Map<string, number>>(new Map())
  const loadGenerationRef = useRef(0)

  const loadDirectory = useCallback(async (path: string) => {
    const generation = loadGenerationRef.current
    if (inFlightLoadsRef.current.has(path)) return
    inFlightLoadsRef.current.set(path, generation)
    setNodes(prev => {
      const current = prev[path]
      if (!current) return prev
      return { ...prev, [path]: { ...current, loading: true, error: null } }
    })
    try {
      const result = await window.api.editorListDirectory({ root, path, showHidden })
      if (generation !== loadGenerationRef.current) return
      if (!result.ok) {
        if (path === '') setError(result.error)
        setNodes(prev => {
          const current = prev[path]
          if (!current) return prev
          return { ...prev, [path]: { ...current, loading: false, error: result.error } }
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
        return { ...prev, [path]: { ...current, children: result.entries, loading: false, error: null } }
      })
    } finally {
      if (inFlightLoadsRef.current.get(path) === generation) {
        inFlightLoadsRef.current.delete(path)
      }
    }
  }, [root, showHidden])

  useEffect(() => {
    loadGenerationRef.current += 1
    inFlightLoadsRef.current.clear()
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
  }, [loadDirectory, root])

  // Dismiss the context menu on any outside interaction. Capture-phase so
  // a click that lands on another menu trigger still closes this menu
  // first instead of stacking two.
  useEffect(() => {
    if (!menu) return
    const close = () => {
      setMenu(null)
      setArmedDelete(null)
    }
    window.addEventListener('mousedown', close, true)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close, true)
      window.removeEventListener('blur', close)
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

  const toggleDirectory = useCallback((entry: EditorFsEntry) => {
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
  }, [ensureNode, loadDirectory, nodes])

  // ── Mutations (create / rename / delete) ──────────────────────────
  // All go through the editor-fs IPC (root-contained in main); the tree
  // reloads the affected parent instead of optimistically patching state
  // so what's shown is always what a real readdir returned.

  const beginCreate = useCallback(
    (kind: 'create-file' | 'create-dir', target: EditorFsEntry | null) => {
      const parentPath = target
        ? target.isDirectory
          ? target.path
          : dirname(target.path)
        : ''
      if (target?.isDirectory) {
        // Creating inside a collapsed folder would put the input row in
        // an invisible subtree — expand first.
        ensureNode(target)
        setExpanded(prev => new Set(prev).add(target.path))
        if (!nodes[target.path]?.children) void loadDirectory(target.path)
      }
      setMenu(null)
      setEdit({ kind, parentPath, draft: '' })
    },
    [ensureNode, loadDirectory, nodes],
  )

  const commitCreate = useCallback(async () => {
    if (!edit || edit.kind === 'rename') return
    const name = edit.draft.trim()
    if (!name) {
      setEdit(null)
      return
    }
    const path = edit.parentPath ? `${edit.parentPath}/${name}` : name
    const result =
      edit.kind === 'create-file'
        ? await window.api.editorCreateFile({ root, path })
        : await window.api.editorCreateDirectory({ root, path })
    setEdit(null)
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    await loadDirectory(edit.parentPath)
    if (edit.kind === 'create-file') onOpenFile(result.path)
  }, [edit, loadDirectory, onOpenFile, root])

  const commitRename = useCallback(async () => {
    if (!edit || edit.kind !== 'rename') return
    const newName = edit.draft.trim()
    const entry = edit.entry
    setEdit(null)
    if (!newName || newName === entry.name) return
    const parent = dirname(entry.path)
    const toPath = parent ? `${parent}/${newName}` : newName
    const result = await window.api.editorRename({ root, fromPath: entry.path, toPath })
    if (!result.ok) {
      setError(result.error)
      return
    }
    setError(null)
    await loadDirectory(parent)
    if (!entry.isDirectory) onFileRenamed?.(entry.path, result.path)
  }, [edit, loadDirectory, onFileRenamed, root])

  const commitDelete = useCallback(
    async (entry: EditorFsEntry) => {
      setMenu(null)
      setArmedDelete(null)
      const result = await window.api.editorDelete({ root, path: entry.path })
      if (!result.ok) {
        setError(result.error)
        return
      }
      setError(null)
      await loadDirectory(dirname(entry.path))
      if (!entry.isDirectory) onFileDeleted?.(entry.path)
    },
    [loadDirectory, onFileDeleted, root],
  )

  const rootNode = nodes['']
  const entries = rootNode?.children ?? rootEntries

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

  return (
    <aside className="relative flex h-full min-h-0 w-full flex-shrink-0 flex-col border-r border-border bg-surface font-code text-[12px]">
      <div
        className="flex h-8 flex-shrink-0 items-center justify-between border-b border-border px-2 text-[10px] uppercase tracking-wider text-muted"
        title={root}
        onContextMenu={event => {
          event.preventDefault()
          setMenu({ x: event.clientX, y: event.clientY, entry: null })
        }}
      >
        <span className="truncate">{basename(root)}</span>
        <span className="flex items-center gap-1">
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
              setMenu({ x: event.clientX, y: event.clientY, entry: null })
            }}
            className="flex h-5 w-5 items-center justify-center rounded text-muted hover:bg-surface-hi hover:text-ink"
          >
            +
          </button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {error ? (
          <div className="px-2 py-1 text-danger">{error}</div>
        ) : (
          <>
            {edit && edit.kind !== 'rename' && edit.parentPath === '' && (
              <InlineEditRow
                depth={0}
                placeholder={edit.kind === 'create-file' ? 'new-file.ts' : 'new-folder'}
                value={edit.draft}
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
              depth={0}
              edit={edit}
              onOpenFile={onOpenFile}
              onToggleDirectory={toggleDirectory}
              onContextMenu={(event, entry) => {
                event.preventDefault()
                event.stopPropagation()
                setArmedDelete(null)
                setMenu({ x: event.clientX, y: event.clientY, entry })
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
      </div>
      {menu && (
        // mousedown on the menu itself must not bubble to the window
        // capture listener that closes the menu.
        <div
          className="fixed z-30 min-w-[160px] rounded border border-border bg-surface py-1 shadow-lg"
          style={{ left: menu.x, top: menu.y }}
          onMouseDown={event => event.stopPropagation()}
        >
          <MenuItem
            label="New File"
            onClick={() => beginCreate('create-file', menu.entry)}
          />
          <MenuItem
            label="New Folder"
            onClick={() => beginCreate('create-dir', menu.entry)}
          />
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
                label={
                  armedDelete === menu.entry.path
                    ? 'Delete — click to confirm'
                    : 'Delete'
                }
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
  onClick,
}: {
  label: string
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
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
  onChange,
  onCommit,
  onCancel,
}: {
  depth: number
  placeholder: string
  value: string
  onChange: (value: string) => void
  onCommit: () => void
  onCancel: () => void
}) {
  return (
    <div className="flex h-[22px] items-center pr-2" style={{ paddingLeft: 21 + depth * 12 }}>
      <input
        autoFocus
        value={value}
        placeholder={placeholder}
        onChange={event => onChange(event.target.value)}
        onKeyDown={event => {
          if (event.key === 'Enter') onCommit()
          if (event.key === 'Escape') onCancel()
        }}
        onBlur={onCancel}
        className="w-full rounded border border-border-hi bg-canvas px-1 py-0.5 text-[11px] text-ink outline-none"
      />
    </div>
  )
}

function TreeEntries({
  entries,
  nodes,
  expanded,
  activeFilePath,
  activeParents,
  depth,
  edit,
  onOpenFile,
  onToggleDirectory,
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
  depth: number
  edit: EditState
  onOpenFile: (path: string) => void
  onToggleDirectory: (entry: EditorFsEntry) => void
  onContextMenu: (event: ReactMouseEvent, entry: EditorFsEntry) => void
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
                onChange={onEditChange}
                onCommit={onEditCommit}
                onCancel={onEditCancel}
              />
            ) : (
              <button
                type="button"
                onClick={() => entry.isDirectory ? onToggleDirectory(entry) : onOpenFile(entry.path)}
                onContextMenu={event => onContextMenu(event, entry)}
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
              <div>
                {edit &&
                  edit.kind !== 'rename' &&
                  edit.parentPath === entry.path && (
                    <InlineEditRow
                      depth={depth + 1}
                      placeholder={edit.kind === 'create-file' ? 'new-file.ts' : 'new-folder'}
                      value={edit.draft}
                      onChange={onEditChange}
                      onCommit={onEditCommit}
                      onCancel={onEditCancel}
                    />
                  )}
                {node?.loading ? (
                  <div className="py-0.5 text-[10px] text-muted" style={{ paddingLeft: 28 + depth * 12 }}>
                    loading…
                  </div>
                ) : node?.error ? (
                  <div className="py-0.5 text-[10px] text-danger" style={{ paddingLeft: 28 + depth * 12 }}>
                    {node.error}
                  </div>
                ) : (
                  <TreeEntries
                    entries={node?.children ?? []}
                    nodes={nodes}
                    expanded={expanded}
                    activeFilePath={activeFilePath}
                    activeParents={activeParents}
                    depth={depth + 1}
                    edit={edit}
                    onOpenFile={onOpenFile}
                    onToggleDirectory={onToggleDirectory}
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
