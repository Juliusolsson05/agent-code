import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { basename, dirname } from '@renderer/features/editor/lib/path'
import { FileIcon, FolderIcon } from '@renderer/features/editor/lib/fileIcon'

type EditorFsEntry = {
  name: string
  path: string
  isDirectory: boolean
  size: number | null
  mtimeMs: number
}

type TreeNode = {
  entry: EditorFsEntry
  children: EditorFsEntry[] | null
  loading: boolean
  error: string | null
}

type Props = {
  root: string
  activeFilePath: string | null
  onOpenFile: (path: string) => void
}

export function ExplorerPane({ root, activeFilePath, onOpenFile }: Props) {
  const [nodes, setNodes] = useState<Record<string, TreeNode>>({})
  const [rootEntries, setRootEntries] = useState<EditorFsEntry[]>([])
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']))
  const [error, setError] = useState<string | null>(null)
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
      const result = await window.api.editorListDirectory({ root, path })
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
  }, [root])

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
    void loadDirectory('')
  }, [loadDirectory, root])

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
    <aside className="flex h-full min-h-0 w-[260px] flex-shrink-0 flex-col border-r border-border bg-surface font-code text-[12px]">
      <div
        className="flex h-8 flex-shrink-0 items-center justify-between border-b border-border px-2 text-[10px] uppercase tracking-wider text-muted"
        title={root}
      >
        <span className="truncate">{basename(root)}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {error ? (
          <div className="px-2 py-1 text-danger">{error}</div>
        ) : (
          <TreeEntries
            entries={entries}
            nodes={nodes}
            expanded={expanded}
            activeFilePath={activeFilePath}
            activeParents={activeParents}
            depth={0}
            onOpenFile={onOpenFile}
            onToggleDirectory={toggleDirectory}
          />
        )}
      </div>
    </aside>
  )
}

function TreeEntries({
  entries,
  nodes,
  expanded,
  activeFilePath,
  activeParents,
  depth,
  onOpenFile,
  onToggleDirectory,
}: {
  entries: EditorFsEntry[]
  nodes: Record<string, TreeNode>
  expanded: Set<string>
  activeFilePath: string | null
  activeParents: Set<string>
  depth: number
  onOpenFile: (path: string) => void
  onToggleDirectory: (entry: EditorFsEntry) => void
}) {
  return (
    <>
      {entries.map(entry => {
        const node = nodes[entry.path]
        const isExpanded = expanded.has(entry.path)
        const isActive = activeFilePath === entry.path
        const isActiveParent = activeParents.has(entry.path)
        // WHY a constant-width caret column instead of injecting glyphs:
        //   keeps file-icon X positions aligned across files and folders so
        //   the eye can scan the column without zig-zag indentation.
        const rowStyle = { paddingLeft: 6 + depth * 12 }
        return (
          <div key={entry.path || entry.name}>
            <button
              type="button"
              onClick={() => entry.isDirectory ? onToggleDirectory(entry) : onOpenFile(entry.path)}
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
            {entry.isDirectory && isExpanded && (
              <div>
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
                    onOpenFile={onOpenFile}
                    onToggleDirectory={onToggleDirectory}
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
