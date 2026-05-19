import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  AiWorkspaceFileEntry,
  AiWorkspaceRecord,
} from '@mcp/shared/aiWorkspaceTypes'
import { normalizeCodeLanguage } from '@shared/code/language'
import { basename } from '@renderer/features/editor/lib/path'
import type { EditorFileBuffer } from '@renderer/features/editor/types'
import { EditorWorkbench } from '@renderer/features/editor/ui/EditorWorkbench'
import { useGlobalEditorStore } from '@renderer/features/global-editor/store'
import { AiWorkspaceFileList } from '@renderer/features/ai-workspace/ui/AiWorkspaceFileList'

type Props = {
  workspaceId: string
  onClose: () => void
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
  // Reuse the Global Editor sidebar width instead of minting a second AI
  // Workspace-specific preference. AI Workspace is mounted inside the Global
  // Editor left pane, and to the user this is still "the editor sidebar",
  // just backed by a curated multi-root file source. Sharing the width keeps
  // the surface from feeling like two unrelated editors while still leaving
  // file loading/writing on the AI Workspace registry boundary below.
  const fileTreeWidthPx = useGlobalEditorStore(state => state.fileTreeWidthPx)
  const setFileTreeWidthPx = useGlobalEditorStore(state => state.setFileTreeWidthPx)
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
    <EditorWorkbench
      sidebar={
        <AiWorkspaceFileList
          title={workspace?.name ?? 'AI Workspace'}
          entries={workspace?.entries ?? []}
          loading={loading}
          error={error}
          activeEntryId={activeFilePath}
          onOpenEntry={entry => void openEntry(entry)}
          onRefresh={() => void loadWorkspace()}
          onClose={onClose}
        />
      }
      sidebarWidthPx={fileTreeWidthPx}
      onSidebarWidthChange={setFileTreeWidthPx}
      fileOrder={fileOrder}
      openFiles={openFiles}
      activeFilePath={activeFilePath}
      activeFile={activeFile}
      // The AI Workspace editor intentionally opens absolute files from many
      // roots. MonacoFileEditor only needs this prop as a lifecycle key for
      // editor/model recreation; the actual file URI comes from
      // `file.absolutePath`, so the workspace id is the stable identity for
      // this curated surface.
      projectRoot={workspaceId}
      onActivateFile={setActiveFilePath}
      onCloseFile={closeFile}
      onChangeFile={updateText}
      onSave={() => void saveActive()}
    />
  )
}
