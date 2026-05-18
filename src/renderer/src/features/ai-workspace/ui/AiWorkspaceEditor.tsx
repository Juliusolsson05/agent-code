import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  AiWorkspaceFileEntry,
  AiWorkspaceRecord,
} from '@mcp/shared/aiWorkspaceTypes'
import { normalizeCodeLanguage } from '@shared/code/language'
import { FileIcon } from '@renderer/features/editor/lib/fileIcon'
import { basename } from '@renderer/features/editor/lib/path'
import type { EditorFileBuffer } from '@renderer/features/editor/types'
import { EditorTabs } from '@renderer/features/editor/ui/EditorTabs'
import { MonacoFileEditor } from '@renderer/features/editor/ui/MonacoFileEditor'

type Props = {
  workspaceId: string
  onClose: () => void
}

function fileTitle(entry: AiWorkspaceFileEntry): string {
  return entry.title || basename(entry.path)
}

function workspaceLabel(entry: AiWorkspaceFileEntry): string {
  if (entry.gitBranch) return entry.gitBranch
  if (entry.projectRoot) return basename(entry.projectRoot)
  return basename(entry.path)
}

function bufferFromEntry(
  entry: AiWorkspaceFileEntry,
  text: string,
  mtimeMs: number,
): EditorFileBuffer {
  return {
    path: entry.entryId,
    absolutePath: entry.path,
    language: normalizeCodeLanguage(null, basename(entry.path)),
    savedText: text,
    currentText: text,
    dirty: false,
    loading: false,
    error: null,
    mtimeMs,
    selection: null,
  }
}

export function AiWorkspaceEditor({ workspaceId, onClose }: Props) {
  const [workspace, setWorkspace] = useState<AiWorkspaceRecord | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fileOrder, setFileOrder] = useState<string[]>([])
  const [openFiles, setOpenFiles] = useState<Record<string, EditorFileBuffer>>({})
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null)

  const loadWorkspace = useCallback(async () => {
    setLoading(true)
    try {
      const next = await window.api.aiWorkspaceGet(workspaceId)
      setWorkspace(next)
      setError(next ? null : 'AI Workspace not found')
    } catch (err) {
      setWorkspace(null)
      setError(err instanceof Error ? err.message : 'Failed to load AI Workspace')
    } finally {
      setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    void loadWorkspace()
  }, [loadWorkspace])

  const entriesById = useMemo(() => {
    const map = new Map<string, AiWorkspaceFileEntry>()
    for (const entry of workspace?.entries ?? []) map.set(entry.entryId, entry)
    return map
  }, [workspace?.entries])

  const openEntry = useCallback(async (entry: AiWorkspaceFileEntry) => {
    if (!entry.status.exists || !entry.status.readable) return
    const result = await window.api.aiWorkspaceReadFile(entry.path)
    if (!result.ok) {
      setFileOrder(prev => prev.includes(entry.entryId) ? prev : [...prev, entry.entryId])
      setOpenFiles(prev => ({
        ...prev,
        [entry.entryId]: {
          path: entry.entryId,
          absolutePath: entry.path,
          language: normalizeCodeLanguage(null, basename(entry.path)),
          savedText: '',
          currentText: '',
          dirty: false,
          loading: false,
          error: result.error,
          mtimeMs: null,
          selection: null,
        },
      }))
      setActiveFilePath(entry.entryId)
      return
    }
    setOpenFiles(prev => ({
      ...prev,
      [entry.entryId]: bufferFromEntry(entry, result.text, result.mtimeMs),
    }))
    setFileOrder(prev => prev.includes(entry.entryId) ? prev : [...prev, entry.entryId])
    setActiveFilePath(entry.entryId)
  }, [])

  const updateText = useCallback((entryId: string, text: string) => {
    setOpenFiles(prev => {
      const current = prev[entryId]
      if (!current) return prev
      return {
        ...prev,
        [entryId]: {
          ...current,
          currentText: text,
          dirty: text !== current.savedText,
        },
      }
    })
  }, [])

  const saveActive = useCallback(async () => {
    if (!activeFilePath) return
    const buffer = openFiles[activeFilePath]
    const entry = entriesById.get(activeFilePath)
    if (!buffer || !entry || !buffer.dirty) return
    const result = await window.api.aiWorkspaceWriteFile({
      path: entry.path,
      text: buffer.currentText,
      expectedMtimeMs: buffer.mtimeMs,
    })
    if (!result.ok) {
      setOpenFiles(prev => ({
        ...prev,
        [activeFilePath]: { ...buffer, error: result.error },
      }))
      return
    }
    setOpenFiles(prev => ({
      ...prev,
      [activeFilePath]: {
        ...buffer,
        savedText: buffer.currentText,
        dirty: false,
        mtimeMs: result.mtimeMs,
        error: null,
      },
    }))
    void loadWorkspace()
  }, [activeFilePath, entriesById, loadWorkspace, openFiles])

  const closeFile = useCallback((entryId: string) => {
    setFileOrder(prev => prev.filter(id => id !== entryId))
    setOpenFiles(prev => {
      const next = { ...prev }
      delete next[entryId]
      return next
    })
    setActiveFilePath(prev => prev === entryId ? null : prev)
    return true
  }, [])

  const activeFile = activeFilePath ? openFiles[activeFilePath] ?? null : null

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      <aside className="flex h-full w-[280px] flex-shrink-0 flex-col border-r border-border bg-surface font-code text-[12px]">
        <div className="flex h-8 flex-shrink-0 items-center justify-between gap-2 border-b border-border px-2 text-[10px] uppercase tracking-wider text-muted">
          <span className="min-w-0 flex-1 truncate">{workspace?.name ?? 'AI Workspace'}</span>
          <div className="flex flex-shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => void loadWorkspace()}
              className="text-muted hover:text-ink"
            >
              refresh
            </button>
            <button
              type="button"
              onClick={onClose}
              className="border border-border bg-surface-hi px-1.5 py-0.5 text-muted hover:border-accent hover:text-ink"
            >
              close
            </button>
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
          {loading ? (
            <div className="px-2 py-1 text-muted">loading...</div>
          ) : error ? (
            <div className="px-2 py-1 text-danger">{error}</div>
          ) : workspace?.entries.length === 0 ? (
            <div className="px-2 py-1 text-muted">No files attached.</div>
          ) : (
            workspace?.entries.map(entry => {
              const stale = !entry.status.exists || !entry.status.readable
              return (
                <button
                  key={entry.entryId}
                  type="button"
                  disabled={stale}
                  onClick={() => void openEntry(entry)}
                  className={`flex w-full items-start gap-2 px-2 py-1.5 text-left transition-colors ${
                    activeFilePath === entry.entryId
                      ? 'bg-accent-soft text-ink'
                      : stale
                        ? 'text-muted opacity-70'
                        : 'text-ink-dim hover:bg-surface-hi hover:text-ink'
                  }`}
                  title={entry.path}
                >
                  <span className="mt-0.5 flex h-4 w-4 flex-shrink-0 items-center justify-center">
                    <FileIcon name={entry.path} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{fileTitle(entry)}</span>
                    <span className="block truncate text-[10px] text-muted">
                      {stale ? entry.status.staleReason ?? 'stale' : workspaceLabel(entry)}
                    </span>
                  </span>
                </button>
              )
            })
          )}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <EditorTabs
          fileOrder={fileOrder}
          openFiles={openFiles}
          activeFilePath={activeFilePath}
          onActivate={setActiveFilePath}
          onClose={closeFile}
        />
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <MonacoFileEditor
            file={activeFile}
            // The AI Workspace editor intentionally opens absolute files from
            // many roots. MonacoFileEditor only needs this prop as a lifecycle
            // key for editor/model recreation; the actual file URI comes from
            // `file.absolutePath`, so the workspace id is the stable identity
            // for this curated surface.
            projectRoot={workspaceId}
            onChange={updateText}
            onSave={() => void saveActive()}
          />
        </div>
      </div>
    </div>
  )
}
