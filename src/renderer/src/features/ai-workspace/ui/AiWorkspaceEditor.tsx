import { useCallback, useEffect, useMemo, useState } from 'react'

import type {
  AiWorkspaceFileEntry,
  AiWorkspaceRecord,
} from '@mcp/shared/aiWorkspaceTypes'
import { normalizeCodeLanguage } from '@shared/code/language'
import { basename } from '@renderer/features/editor/lib/path'
import { disposeEditorModel } from '@renderer/features/editor/lib/editorModelRegistry'
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
    conflict: false,
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
          conflict: false,
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
          // Same contract as the Global Editor store: typing past a save
          // error clears it — the next Cmd+S re-runs the authoritative
          // mtime check, so a pinned stale message only misleads.
          error: null,
          conflict: false,
        },
      }
    })
  }, [])

  // Parameterized (not "active-only") so the confirm dialog's
  // Save & Close can target the tab being closed, which is not
  // necessarily the active one.
  const saveFile = useCallback(async (entryId: string): Promise<boolean> => {
    const buffer = openFiles[entryId]
    const entry = entriesById.get(entryId)
    if (!buffer || !entry) return false
    if (!buffer.dirty) return true
    const result = await window.api.aiWorkspaceWriteFile({
      path: entry.path,
      text: buffer.currentText,
      expectedMtimeMs: buffer.mtimeMs,
    })
    if (!result.ok) {
      setOpenFiles(prev => ({
        ...prev,
        [entryId]: { ...buffer, error: result.error, conflict: result.conflict === true },
      }))
      return false
    }
    setOpenFiles(prev => ({
      ...prev,
      [entryId]: {
        ...buffer,
        savedText: buffer.currentText,
        dirty: false,
        mtimeMs: result.mtimeMs,
        error: null,
        conflict: false,
      },
    }))
    void loadWorkspace()
    return true
  }, [entriesById, loadWorkspace, openFiles])

  const saveActive = useCallback(async () => {
    if (!activeFilePath) return
    await saveFile(activeFilePath)
  }, [activeFilePath, saveFile])

  const closeFile = useCallback(
    (entryId: string, opts?: { force?: boolean }) => {
      // Same dirty-close contract as the Global Editor store: refuse
      // without force so EditorWorkbench can interpose its confirm
      // dialog. The dirty check reads the render-scoped `openFiles`
      // closure (NOT a setState updater side-channel — updaters run at
      // render time, so a flag written inside one is not readable
      // synchronously after the setState call).
      const buffer = openFiles[entryId]
      if (buffer?.dirty && !opts?.force) return false
      setOpenFiles(prev => {
        const next = { ...prev }
        delete next[entryId]
        return next
      })
      setFileOrder(prev => prev.filter(id => id !== entryId))
      setActiveFilePath(prev => (prev === entryId ? null : prev))
      // AI Workspace buffers carry the file's real absolute path (they
      // are multi-root by design), which is exactly the model registry
      // key — dispose so a closed tab's model doesn't linger.
      if (buffer) disposeEditorModel(buffer.absolutePath)
      return true
    },
    [openFiles],
  )

  const saveThenClose = useCallback(
    async (entryId: string): Promise<boolean> => {
      const ok = await saveFile(entryId)
      if (ok) closeFile(entryId, { force: true })
      return ok
    },
    [saveFile, closeFile],
  )

  // Conflict-banner recovery. Reload = disk wins; Overwrite = buffer
  // wins with the mtime check skipped once (explicit user decision).
  const reloadFromDisk = useCallback(
    async (entryId: string) => {
      const entry = entriesById.get(entryId)
      if (!entry) return
      const result = await window.api.aiWorkspaceReadFile(entry.path)
      setOpenFiles(prev => {
        const current = prev[entryId]
        if (!current) return prev
        if (!result.ok) {
          return { ...prev, [entryId]: { ...current, error: result.error, conflict: false } }
        }
        return {
          ...prev,
          [entryId]: {
            ...current,
            savedText: result.text,
            currentText: result.text,
            dirty: false,
            mtimeMs: result.mtimeMs,
            error: null,
            conflict: false,
          },
        }
      })
    },
    [entriesById],
  )

  const overwriteDisk = useCallback(
    async (entryId: string) => {
      const buffer = openFiles[entryId]
      const entry = entriesById.get(entryId)
      if (!buffer || !entry) return
      const result = await window.api.aiWorkspaceWriteFile({
        path: entry.path,
        text: buffer.currentText,
        expectedMtimeMs: null,
      })
      setOpenFiles(prev => {
        const current = prev[entryId]
        if (!current) return prev
        if (!result.ok) {
          return {
            ...prev,
            [entryId]: { ...current, error: result.error, conflict: result.conflict === true },
          }
        }
        return {
          ...prev,
          [entryId]: {
            ...current,
            savedText: current.currentText,
            dirty: false,
            mtimeMs: result.mtimeMs,
            error: null,
            conflict: false,
          },
        }
      })
    },
    [entriesById, openFiles],
  )

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
      onSaveThenClose={saveThenClose}
      onReloadFromDisk={entryId => void reloadFromDisk(entryId)}
      onOverwriteDisk={entryId => void overwriteDisk(entryId)}
    />
  )
}
