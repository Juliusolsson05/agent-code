import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { AiWorkspaceFileEntry, AiWorkspaceRecord } from '@mcp/shared/aiWorkspaceTypes'
import {
  aiWorkspaceSurfaceCache,
  cacheAiWorkspaceSurface,
} from '@renderer/features/ai-workspace/lib/aiWorkspaceSurfaceCache'
import { AiWorkspaceFileList } from '@renderer/features/ai-workspace/ui/AiWorkspaceFileList'
import { basename } from '@renderer/features/editor/lib/path'
import {
  makeBuffer,
  hasRecoverableBufferChanges,
  withDiskObserved,
  withDiskSnapshot,
  withError,
  withFocusRequested,
  withTextUpdate,
  withWriteAcknowledged,
} from '@renderer/features/editor/lib/bufferOps'
import { releaseEditorModelOwner } from '@renderer/features/editor/lib/editorModelRegistry'
import type { EditorFileBuffer } from '@renderer/features/editor/types'
import { EditorWorkbench } from '@renderer/features/editor/ui/EditorWorkbench'
import { useGlobalEditorStore } from '@renderer/features/global-editor/store'

type Props = {
  workspaceId: string
  visible: boolean
  onClose: () => void
}

function bufferFromEntry(
  entry: AiWorkspaceFileEntry,
  text: string,
  mtimeMs: number,
): EditorFileBuffer {
  return makeBuffer({
    path: entry.entryId,
    absolutePath: entry.path,
    fileName: basename(entry.path),
    text,
    mtimeMs,
  })
}

export function AiWorkspaceEditor({ workspaceId, visible, onClose }: Props) {
  // Reuse the Global Editor sidebar width instead of minting a second AI
  // Workspace-specific preference. AI Workspace is mounted inside the Global
  // Editor left pane, and to the user this is still "the editor sidebar",
  // just backed by a curated multi-root file source. Sharing the width keeps
  // the surface from feeling like two unrelated editors while still leaving
  // file loading/writing on the AI Workspace registry boundary below.
  const fileTreeWidthPx = useGlobalEditorStore(state => state.fileTreeWidthPx)
  const setFileTreeWidthPx = useGlobalEditorStore(state => state.setFileTreeWidthPx)
  const fileTreeVisible = useGlobalEditorStore(state => state.fileTreeVisible)
  const cached = aiWorkspaceSurfaceCache.get(workspaceId)
  const [workspace, setWorkspace] = useState<AiWorkspaceRecord | null>(
    () => cached?.workspace ?? null,
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(() => cached?.error ?? null)
  const [fileOrder, setFileOrder] = useState<string[]>(() => cached?.fileOrder ?? [])
  const [openFiles, setOpenFiles] = useState<Record<string, EditorFileBuffer>>(
    () => cached?.openFiles ?? {},
  )
  const [activeFilePath, setActiveFilePath] = useState<string | null>(
    () => cached?.activeFilePath ?? null,
  )
  const openFilesRef = useRef(openFiles)
  openFilesRef.current = openFiles
  const fileOrderRef = useRef(fileOrder)
  fileOrderRef.current = fileOrder
  const workspaceLoadGenerationRef = useRef(0)
  const entryReadGenerationRef = useRef(new Map<string, number>())
  const openIntentGenerationRef = useRef(0)
  const entryMetadataRef = useRef(
    new Map<string, AiWorkspaceFileEntry>(Object.entries(cached?.entriesById ?? {})),
  )
  const pendingFileWritesRef = useRef(new Map<string, Promise<void>>())
  const mountedRef = useRef(true)

  useLayoutEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useLayoutEffect(() => {
    cacheAiWorkspaceSurface(workspaceId, {
      workspace,
      error,
      fileOrder,
      openFiles,
      activeFilePath,
      entriesById: Object.fromEntries(entryMetadataRef.current),
    })
  }, [workspaceId, workspace, error, fileOrder, openFiles, activeFilePath])

  const currentOpenFiles = useCallback(
    () =>
      mountedRef.current
        ? openFilesRef.current
        : (aiWorkspaceSurfaceCache.get(workspaceId)?.openFiles ?? openFilesRef.current),
    [workspaceId],
  )

  const applyOpenFiles = useCallback(
    (
      transition: (previous: Record<string, EditorFileBuffer>) => Record<string, EditorFileBuffer>,
    ) => {
      // A workspace switch unmounts this state owner while an already-issued
      // write may still succeed. React intentionally ignores setState after
      // unmount, but the module cache is now the owner of those buffers. Apply
      // the generation-checked acknowledgement there so returning to the
      // workspace does not resurrect a falsely dirty pre-save snapshot. Write
      // the cache even while mounted as well: a parent workspace switch can be
      // batched with this update before the layout effect gets a commit.
      const surface = aiWorkspaceSurfaceCache.get(workspaceId)
      if (surface) surface.openFiles = transition(surface.openFiles)
      if (mountedRef.current) setOpenFiles(transition)
    },
    [workspaceId],
  )

  const serializeFileWrite = useCallback(
    async <T,>(entryId: string, task: () => Promise<T>): Promise<T> => {
      const previous = pendingFileWritesRef.current.get(entryId) ?? Promise.resolve()
      let release!: () => void
      const current = new Promise<void>(resolve => {
        release = resolve
      })
      pendingFileWritesRef.current.set(entryId, current)
      await previous.catch(() => undefined)
      try {
        return await task()
      } finally {
        release()
        if (pendingFileWritesRef.current.get(entryId) === current) {
          pendingFileWritesRef.current.delete(entryId)
        }
      }
    },
    [],
  )

  const loadWorkspace = useCallback(async () => {
    const generation = ++workspaceLoadGenerationRef.current
    setLoading(true)
    try {
      const next = await window.api.aiWorkspaceGet(workspaceId)
      if (generation !== workspaceLoadGenerationRef.current) return
      for (const entry of next?.entries ?? []) {
        entryMetadataRef.current.set(entry.entryId, entry)
      }
      setWorkspace(next)
      setError(next ? null : 'AI Workspace not found')
    } catch (err) {
      if (generation !== workspaceLoadGenerationRef.current) return
      setWorkspace(null)
      setError(err instanceof Error ? err.message : 'Failed to load AI Workspace')
    } finally {
      if (generation === workspaceLoadGenerationRef.current) setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    void loadWorkspace()
  }, [loadWorkspace])

  const entriesById = useMemo(() => {
    const map = new Map(entryMetadataRef.current)
    for (const entry of workspace?.entries ?? []) map.set(entry.entryId, entry)
    return map
  }, [workspace])

  const openEntry = useCallback(async (entry: AiWorkspaceFileEntry) => {
    if (!entry.status.exists || !entry.status.readable) return
    const readGeneration = (entryReadGenerationRef.current.get(entry.entryId) ?? 0) + 1
    entryReadGenerationRef.current.set(entry.entryId, readGeneration)
    const intentGeneration = ++openIntentGenerationRef.current
    const result = await window.api.aiWorkspaceReadFile(entry.path).catch(err => ({
      ok: false as const,
      error: err instanceof Error ? err.message : 'failed to read file',
    }))
    if (!mountedRef.current) return
    if (entryReadGenerationRef.current.get(entry.entryId) !== readGeneration) {
      return
    }
    if (!result.ok) {
      setFileOrder(prev => (prev.includes(entry.entryId) ? prev : [...prev, entry.entryId]))
      setOpenFiles(prev => {
        const current = prev[entry.entryId]
        const fallback =
          current ??
          makeBuffer({
            path: entry.entryId,
            absolutePath: entry.path,
            fileName: basename(entry.path),
            text: '',
            mtimeMs: null,
          })
        return {
          ...prev,
          [entry.entryId]: withFocusRequested(withError(fallback, result.error)),
        }
      })
      if (intentGeneration === openIntentGenerationRef.current) {
        setActiveFilePath(entry.entryId)
      }
      return
    }
    setOpenFiles(prev => {
      const existing = prev[entry.entryId]
      const observed = existing
        ? withDiskObserved(existing, result.text, result.mtimeMs)
        : bufferFromEntry(entry, result.text, result.mtimeMs)
      return { ...prev, [entry.entryId]: withFocusRequested(observed) }
    })
    setFileOrder(prev => (prev.includes(entry.entryId) ? prev : [...prev, entry.entryId]))
    if (intentGeneration === openIntentGenerationRef.current) {
      setActiveFilePath(entry.entryId)
    }
  }, [])

  const updateText = useCallback((entryId: string, text: string) => {
    setOpenFiles(prev => {
      const current = prev[entryId]
      if (!current) return prev
      // Shared transition — same dirty/error semantics as the Global
      // Editor store, by construction (bufferOps).
      return { ...prev, [entryId]: withTextUpdate(current, text) }
    })
  }, [])

  // Parameterized (not "active-only") so the confirm dialog's
  // Save & Close can target the tab being closed, which is not
  // necessarily the active one.
  const saveFile = useCallback(
    async (
      entryId: string,
      options?: { recreateDeleted?: boolean },
    ): Promise<{ generation: number; text: string } | null> => {
      return serializeFileWrite(entryId, async () => {
        const buffer = currentOpenFiles()[entryId]
        const entry = entriesById.get(entryId)
        if (!buffer || !entry) return null
        if (!hasRecoverableBufferChanges(buffer)) {
          return { generation: buffer.generation, text: buffer.currentText }
        }
        if (buffer.externalChange === 'deleted' && !options?.recreateDeleted) return null
        const writtenText = buffer.currentText
        const result = await window.api
          .aiWorkspaceWriteFile({
            path: entry.path,
            text: writtenText,
            expectedMtimeMs: options?.recreateDeleted ? null : buffer.mtimeMs,
          })
          .catch(err => ({
            ok: false as const,
            error: err instanceof Error ? err.message : 'failed to save file',
            conflict: false,
          }))
        if (!result.ok) {
          applyOpenFiles(prev => {
            const current = prev[entryId]
            if (!current || current.generation !== buffer.generation) {
              return prev
            }
            return {
              ...prev,
              [entryId]: withError(current, result.error, result.conflict === true),
            }
          })
          return null
        }
        applyOpenFiles(prev => {
          const current = prev[entryId]
          if (!current || current.generation !== buffer.generation) return prev
          return {
            ...prev,
            [entryId]: withWriteAcknowledged(current, writtenText, result.mtimeMs),
          }
        })
        if (mountedRef.current) void loadWorkspace()
        return { generation: buffer.generation, text: writtenText }
      })
    },
    [applyOpenFiles, currentOpenFiles, entriesById, loadWorkspace, serializeFileWrite],
  )

  const saveActive = useCallback(async () => {
    if (!activeFilePath) return
    await saveFile(activeFilePath)
  }, [activeFilePath, saveFile])

  const closeFile = useCallback(
    (entryId: string, opts?: { force?: boolean }) => {
      // Same dirty-close contract as the Global Editor store: refuse
      // without force so EditorWorkbench can interpose its confirm
      // dialog. Read through currentOpenFiles because an in-flight Save & Close
      // can finish after this workspace was switched out and the cache became
      // the state owner.
      const files = currentOpenFiles()
      const buffer = files[entryId]
      if (buffer && hasRecoverableBufferChanges(buffer) && !opts?.force) return false
      const previousOrder = mountedRef.current
        ? fileOrderRef.current
        : (aiWorkspaceSurfaceCache.get(workspaceId)?.fileOrder ?? fileOrderRef.current)
      const closedIndex = previousOrder.indexOf(entryId)
      const nextOrder = previousOrder.filter(id => id !== entryId)
      const nextActive = (previous: string | null) =>
        previous === entryId
          ? (nextOrder[Math.min(closedIndex, nextOrder.length - 1)] ?? null)
          : previous
      if (mountedRef.current) {
        setOpenFiles(prev => {
          const next = { ...prev }
          delete next[entryId]
          return next
        })
        setFileOrder(nextOrder)
        setActiveFilePath(nextActive)
      } else {
        const surface = aiWorkspaceSurfaceCache.get(workspaceId)
        if (surface) {
          const next = { ...files }
          delete next[entryId]
          surface.openFiles = next
          surface.fileOrder = nextOrder
          surface.activeFilePath = nextActive(surface.activeFilePath)
        }
      }
      // AI Workspace buffers carry the file's real absolute path (they
      // are multi-root by design), which is exactly the model registry
      // key. Release this logical buffer owner; another Global/AI surface that
      // has the same absolute file open keeps the shared undo model alive.
      if (buffer) releaseEditorModelOwner(buffer.generation)
      return true
    },
    [currentOpenFiles, workspaceId],
  )

  const saveThenClose = useCallback(
    async (entryId: string): Promise<boolean> => {
      const before = currentOpenFiles()[entryId]
      const written = await saveFile(entryId, {
        recreateDeleted: before?.externalChange === 'deleted',
      })
      if (!written) return false
      // A successful write only acknowledges the submitted snapshot. If the
      // user typed while it was in flight, the buffer is still dirty and the
      // close must keep the newer edits. React may not have committed the
      // acknowledgement setState yet, however, so relying on `dirty` here can
      // also produce a false refusal. The submitted generation/text pair is
      // the exact safe-to-close proof independent of React batching.
      const latest = currentOpenFiles()[entryId]
      if (
        !latest ||
        latest.generation !== written.generation ||
        latest.currentText !== written.text
      ) {
        return false
      }
      return closeFile(entryId, { force: true })
    },
    [saveFile, closeFile, currentOpenFiles],
  )

  // Conflict-banner recovery. Reload = disk wins; Overwrite = buffer
  // wins with the mtime check skipped once (explicit user decision).
  const reloadFromDisk = useCallback(
    async (entryId: string) => {
      const entry = entriesById.get(entryId)
      if (!entry) return
      const before = currentOpenFiles()[entryId]
      if (!before) return
      const result = await window.api.aiWorkspaceReadFile(entry.path).catch(err => ({
        ok: false as const,
        error: err instanceof Error ? err.message : 'failed to reload file',
      }))
      applyOpenFiles(prev => {
        const current = prev[entryId]
        if (!current || current.generation !== before.generation) return prev
        if (!result.ok) {
          return { ...prev, [entryId]: withError(current, result.error) }
        }
        if (current.currentText !== before.currentText) {
          return {
            ...prev,
            [entryId]: withDiskObserved(current, result.text, result.mtimeMs),
          }
        }
        return {
          ...prev,
          [entryId]: withDiskSnapshot(current, result.text, result.mtimeMs),
        }
      })
    },
    [applyOpenFiles, currentOpenFiles, entriesById],
  )

  const overwriteDisk = useCallback(
    async (entryId: string) => {
      await serializeFileWrite(entryId, async () => {
        const buffer = currentOpenFiles()[entryId]
        const entry = entriesById.get(entryId)
        if (!buffer || !entry) return false
        const writtenText = buffer.currentText
        const result = await window.api
          .aiWorkspaceWriteFile({
            path: entry.path,
            text: writtenText,
            expectedMtimeMs: null,
          })
          .catch(err => ({
            ok: false as const,
            error: err instanceof Error ? err.message : 'failed to overwrite file',
            conflict: false,
          }))
        applyOpenFiles(prev => {
          const current = prev[entryId]
          if (!current || current.generation !== buffer.generation) return prev
          if (!result.ok) {
            return {
              ...prev,
              [entryId]: withError(current, result.error, result.conflict === true),
            }
          }
          return {
            ...prev,
            [entryId]: withWriteAcknowledged(current, writtenText, result.mtimeMs),
          }
        })
        return result.ok
      })
    },
    [applyOpenFiles, currentOpenFiles, entriesById, serializeFileWrite],
  )

  const activeFile = activeFilePath ? (openFiles[activeFilePath] ?? null) : null

  // Keep the state owner mounted while hiding the workbench. Local buffers
  // are the AI Workspace's source of truth until saved; unmounting here would
  // discard them, while merely CSS-hiding Monaco would leave duplicate model,
  // LSP, and keyboard listeners alive behind the visible project editor.
  if (!visible) return null

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
      sidebarVisible={fileTreeVisible}
      onSidebarWidthChange={setFileTreeWidthPx}
      fileOrder={fileOrder}
      openFiles={openFiles}
      activeFilePath={activeFilePath}
      activeFile={activeFile}
      lspContext={lspContextForEntry(activeFilePath ? entriesById.get(activeFilePath) : undefined)}
      onActivateFile={(entryId, options) => {
        setActiveFilePath(entryId)
        if (!options.focusEditor) return
        setOpenFiles(prev => {
          const current = prev[entryId]
          return current ? { ...prev, [entryId]: withFocusRequested(current) } : prev
        })
      }}
      onCloseFile={closeFile}
      onChangeFile={updateText}
      onSave={() => void saveActive()}
      onSaveThenClose={saveThenClose}
      onReloadFromDisk={entryId => void reloadFromDisk(entryId)}
      onOverwriteDisk={entryId => void overwriteDisk(entryId)}
      onFocusRequestHandled={entryId => {
        setOpenFiles(prev => {
          const current = prev[entryId]
          if (!current || current.focusRequest === null) return prev
          return { ...prev, [entryId]: { ...current, focusRequest: null } }
        })
      }}
    />
  )
}

function lspContextForEntry(
  entry: AiWorkspaceFileEntry | undefined,
): { workspaceRoot: string; filePath: string } | null {
  if (!entry?.projectRoot) return null
  const root = entry.projectRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const absolute = entry.path.replace(/\\/g, '/')
  if (!absolute.startsWith(`${root}/`)) return null
  const filePath = absolute.slice(root.length + 1)
  if (!filePath || filePath.split('/').some(part => part === '..' || part === '')) {
    return null
  }
  return { workspaceRoot: entry.projectRoot, filePath }
}
