import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import type { AiWorkspaceFileEntry, AiWorkspaceRecord } from '@mcp/shared/aiWorkspaceTypes'
import {
  aiWorkspaceSurfaceCache,
  cacheAiWorkspaceSurface,
} from '@renderer/features/ai-workspace/lib/aiWorkspaceSurfaceCache'
import { withAiWorkspaceReadError } from '@renderer/features/ai-workspace/lib/aiWorkspaceBufferOps'
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
import { mapWithConcurrency } from '@renderer/features/editor/lib/boundedAsyncPool'
import { releaseEditorModelOwner } from '@renderer/features/editor/lib/editorModelRegistry'
import type { EditorFileBuffer } from '@renderer/features/editor/types'
import { EditorWorkbench } from '@renderer/features/editor/ui/EditorWorkbench'
import type { EditorLspContext } from '@renderer/features/editor/ui/MonacoFileEditor'
import { useGlobalEditorStore } from '@renderer/features/global-editor/store'

type Props = {
  workspaceId: string
  visible: boolean
  onClose: () => void
  toolbarActions?: ReactNode
}

function bufferFromEntry(
  entry: AiWorkspaceFileEntry,
  text: string,
  mtimeMs: number,
  diskVersion: string,
): EditorFileBuffer {
  return makeBuffer({
    path: entry.entryId,
    absolutePath: entry.path,
    fileName: basename(entry.path),
    text,
    mtimeMs,
    diskVersion,
  })
}

export function AiWorkspaceEditor({ workspaceId, visible, onClose, toolbarActions }: Props) {
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
  const workspaceRef = useRef(workspace)
  workspaceRef.current = workspace
  const [loading, setLoading] = useState(true)
  const [saveAllPending, setSaveAllPending] = useState(false)
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
  const saveAllPendingRef = useRef(false)
  const mountedRef = useRef(true)
  const disposedWorkspaceRef = useRef(false)
  const workspaceDeletedRef = useRef(false)

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
      const previous = mountedRef.current
        ? openFilesRef.current
        : (surface?.openFiles ?? openFilesRef.current)
      // WHY compute and publish exactly once: per-entry writes are serialized,
      // but React state commits are not. A queued second save could otherwise
      // read the first save's old dirty/version snapshot and report a false
      // conflict. Advancing the imperative source of truth synchronously makes
      // the acknowledgement visible before the write queue releases.
      const next = transition(previous)
      openFilesRef.current = next
      if (surface) surface.openFiles = next
      if (mountedRef.current) setOpenFiles(next)
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

  const loadWorkspace = useCallback(async (): Promise<AiWorkspaceRecord | null> => {
    if (workspaceDeletedRef.current || disposedWorkspaceRef.current) return null
    const generation = ++workspaceLoadGenerationRef.current
    setLoading(true)
    try {
      const next = await window.api.aiWorkspaceGet(workspaceId)
      if (
        generation !== workspaceLoadGenerationRef.current ||
        workspaceDeletedRef.current ||
        disposedWorkspaceRef.current
      ) {
        return null
      }
      for (const entry of next?.entries ?? []) {
        entryMetadataRef.current.set(entry.entryId, entry)
      }
      setWorkspace(next)
      setError(next ? null : 'AI Workspace not found')
      return next
    } catch (err) {
      if (
        generation !== workspaceLoadGenerationRef.current ||
        workspaceDeletedRef.current ||
        disposedWorkspaceRef.current
      ) {
        return null
      }
      setWorkspace(null)
      setError(err instanceof Error ? err.message : 'Failed to load AI Workspace')
      return null
    } finally {
      if (generation === workspaceLoadGenerationRef.current) setLoading(false)
    }
  }, [workspaceId])

  const refreshWorkspace = useCallback(async () => {
    const next = await loadWorkspace()
    if (!next || workspaceDeletedRef.current || disposedWorkspaceRef.current) return
    const attachedEntries = new Map(next.entries.map(entry => [entry.entryId, entry]))
    const openSnapshot = currentOpenFiles()
    const detachedClean = Object.entries(openSnapshot).filter(
      ([entryId, buffer]) => !attachedEntries.has(entryId) && !hasRecoverableBufferChanges(buffer),
    )
    if (detachedClean.length > 0) {
      const removedBuffers = new Map<string, EditorFileBuffer>()
      applyOpenFiles(previous => {
        const remaining = { ...previous }
        for (const [entryId, snapshot] of detachedClean) {
          const current = remaining[entryId]
          if (
            current?.generation === snapshot.generation &&
            !hasRecoverableBufferChanges(current)
          ) {
            removedBuffers.set(entryId, current)
            delete remaining[entryId]
          }
        }
        return remaining
      })
      // The transition rechecks recoverability against the synchronous current
      // source of truth. Typing does not change a generation, so using the old
      // candidate list here could hide a just-dirtied buffer and release undo.
      const removedIds = new Set(removedBuffers.keys())
      if (removedIds.size > 0) {
        const nextOrder = fileOrderRef.current.filter(entryId => !removedIds.has(entryId))
        fileOrderRef.current = nextOrder
        setFileOrder(nextOrder)
        setActiveFilePath(previous =>
          previous && removedIds.has(previous) ? (nextOrder.at(-1) ?? null) : previous,
        )
        for (const buffer of removedBuffers.values()) {
          releaseEditorModelOwner(buffer.generation)
        }
      }
    }
    const openEntries = Object.entries(openSnapshot)
    let nextEntryIndex = 0
    const refreshNextEntry = async (): Promise<void> => {
      while (nextEntryIndex < openEntries.length) {
        const nextEntry = openEntries[nextEntryIndex]
        nextEntryIndex += 1
        if (!nextEntry) return
        const [entryId, before] = nextEntry
        const readGeneration = (entryReadGenerationRef.current.get(entryId) ?? 0) + 1
        entryReadGenerationRef.current.set(entryId, readGeneration)
        const entry = attachedEntries.get(entryId)
        if (!entry) {
          if (!hasRecoverableBufferChanges(before)) continue
          applyOpenFiles(previous => {
            const current = previous[entryId]
            if (!current || current.generation !== before.generation) return previous
            return {
              ...previous,
              [entryId]: {
                ...current,
                surfaceWarning:
                  'Removed from this AI Workspace. Save the recoverable buffer or close its tab.',
              },
            }
          })
          continue
        }
        if (!entry.status.exists || entry.status.staleReason === 'not a file') {
          applyOpenFiles(previous => {
            const current = previous[entryId]
            if (!current || current.generation !== before.generation) return previous
            return {
              ...previous,
              [entryId]: withAiWorkspaceReadError(
                current,
                entry.status.staleReason ?? 'does not exist',
              ),
            }
          })
          continue
        }
        const result = await window.api.aiWorkspaceReadFile(entry.path).catch(err => ({
          ok: false as const,
          error: err instanceof Error ? err.message : 'failed to refresh file',
        }))
        // Manual refresh, MCP mutation events, and an explicit open can all
        // overlap. The newest read owns the observation even on filesystems
        // whose coarse mtimes cannot prove which response is older.
        if (
          workspaceDeletedRef.current ||
          disposedWorkspaceRef.current ||
          entryReadGenerationRef.current.get(entryId) !== readGeneration
        ) {
          continue
        }
        applyOpenFiles(previous => {
          const current = previous[entryId]
          if (!current || current.generation !== before.generation) return previous
          return {
            ...previous,
            [entryId]: {
              ...(result.ok
                ? withDiskObserved(current, result.text, result.mtimeMs, result.version)
                : withAiWorkspaceReadError(current, result.error)),
              surfaceWarning: null,
            },
          }
        })
      }
    }
    // WHY a small pool instead of Promise.all(open tabs): each result can be an
    // 8 MB string crossing IPC. A broad curated review workspace should not
    // allocate one large response per tab simultaneously just because metadata
    // changed. Six keeps disks/IPC busy without turning refresh into a memory
    // spike, while per-entry generations above still cancel obsolete results.
    await Promise.all(
      Array.from({ length: Math.min(6, openEntries.length) }, () => refreshNextEntry()),
    )
  }, [applyOpenFiles, currentOpenFiles, loadWorkspace])

  useEffect(() => {
    void refreshWorkspace()
  }, [refreshWorkspace])

  const disposeCleanWorkspace = useCallback(() => {
    if (disposedWorkspaceRef.current) return true
    const files = currentOpenFiles()
    if (Object.values(files).some(hasRecoverableBufferChanges)) return false
    disposedWorkspaceRef.current = true
    for (const buffer of Object.values(files)) releaseEditorModelOwner(buffer.generation)
    aiWorkspaceSurfaceCache.delete(workspaceId)
    onClose()
    return true
  }, [currentOpenFiles, onClose, workspaceId])

  useEffect(
    () =>
      window.api.onAiWorkspaceChanged(event => {
        if (event.workspaceId !== workspaceId) return
        if (event.kind === 'deleted') {
          // Invalidate every metadata/read lane before touching visible state.
          // Registry get/refresh retains an object while it asynchronously
          // stats entries, so an older request can otherwise resolve after the
          // delete event and resurrect the removed workspace in state/cache.
          workspaceDeletedRef.current = true
          workspaceLoadGenerationRef.current += 1
          openIntentGenerationRef.current += 1
          entryReadGenerationRef.current.clear()
          setLoading(false)
          if (disposeCleanWorkspace()) return
          // An MCP client can delete metadata while the user is editing. The
          // process-lifetime file capabilities intentionally remain valid; keep
          // the buffers visible until the user saves/closes them rather than
          // turning a metadata mutation into source loss.
          setWorkspace(null)
          setError('This AI Workspace was deleted. Unsaved open tabs remain available here.')
          return
        }
        void refreshWorkspace()
      }),
    [disposeCleanWorkspace, refreshWorkspace, workspaceId],
  )

  const entriesById = useMemo(() => {
    const map = new Map(entryMetadataRef.current)
    for (const entry of workspace?.entries ?? []) map.set(entry.entryId, entry)
    return map
  }, [workspace])

  const openEntry = useCallback(
    async (
      entry: AiWorkspaceFileEntry,
      selection: EditorFileBuffer['selection'] = null,
    ): Promise<boolean> => {
      if (!entry.status.exists || !entry.status.readable) {
        setError(
          `Could not open ${basename(entry.path)}: ${entry.status.staleReason ?? 'unavailable'}`,
        )
        return false
      }
      const readGeneration = (entryReadGenerationRef.current.get(entry.entryId) ?? 0) + 1
      entryReadGenerationRef.current.set(entry.entryId, readGeneration)
      const intentGeneration = ++openIntentGenerationRef.current
      const result = await window.api.aiWorkspaceReadFile(entry.path).catch(err => ({
        ok: false as const,
        error: err instanceof Error ? err.message : 'failed to read file',
      }))
      if (!mountedRef.current) return false
      if (entryReadGenerationRef.current.get(entry.entryId) !== readGeneration) return false
      if (!result.ok) {
        applyOpenFiles(prev => {
          const current = prev[entry.entryId]
          if (!current) return prev
          return {
            ...prev,
            [entry.entryId]: withFocusRequested(withAiWorkspaceReadError(current, result.error)),
          }
        })
        if (!openFilesRef.current[entry.entryId]) {
          setError(`Could not open ${basename(entry.path)}: ${result.error}`)
        }
        return false
      }
      applyOpenFiles(prev => {
        const existing = prev[entry.entryId]
        const observed = existing
          ? withDiskObserved(existing, result.text, result.mtimeMs, result.version)
          : bufferFromEntry(entry, result.text, result.mtimeMs, result.version)
        return {
          ...prev,
          [entry.entryId]: { ...withFocusRequested(observed), selection },
        }
      })
      if (!fileOrderRef.current.includes(entry.entryId)) {
        const nextOrder = [...fileOrderRef.current, entry.entryId]
        fileOrderRef.current = nextOrder
        setFileOrder(nextOrder)
      }
      setError(null)
      if (intentGeneration === openIntentGenerationRef.current) {
        setActiveFilePath(entry.entryId)
      }
      return true
    },
    [applyOpenFiles],
  )

  const openAiDefinition = useCallback(
    async (absolutePath: string, line: number, column: number): Promise<boolean> => {
      const normalizedTarget = absolutePath.replace(/\\/g, '/')
      const entry = workspaceRef.current?.entries.find(candidate => {
        const normalizedCandidate = candidate.path.replace(/\\/g, '/')
        const caseInsensitive = /^[A-Za-z]:\//.test(normalizedCandidate)
        return caseInsensitive
          ? normalizedCandidate.toLowerCase() === normalizedTarget.toLowerCase()
          : normalizedCandidate === normalizedTarget
      })
      // AI Workspace is a curated review surface, not a project browser. A
      // definition outside the attached set may still be a valid LSP answer,
      // but opening it would silently expand the workspace's authority and
      // violate the consumer promise that this list is the review boundary.
      if (!entry) {
        setError('That definition is not attached to this AI Workspace.')
        return false
      }
      return await openEntry(entry, { line, column })
    },
    [openEntry],
  )

  const updateText = useCallback(
    (entryId: string, text: string) => {
      applyOpenFiles(prev => {
        const current = prev[entryId]
        if (!current) return prev
        // Shared transition — same dirty/error semantics as the Global
        // Editor store, by construction (bufferOps).
        return { ...prev, [entryId]: withTextUpdate(current, text) }
      })
    },
    [applyOpenFiles],
  )

  // Parameterized (not "active-only") so the confirm dialog's
  // Save & Close can target the tab being closed, which is not
  // necessarily the active one.
  const revalidateEntryAfterWrite = useCallback(
    async (entryId: string, path: string, generation: number): Promise<void> => {
      const readGeneration = (entryReadGenerationRef.current.get(entryId) ?? 0) + 1
      entryReadGenerationRef.current.set(entryId, readGeneration)
      const result = await window.api.aiWorkspaceReadFile(path).catch(err => ({
        ok: false as const,
        error: err instanceof Error ? err.message : 'failed to verify saved file',
      }))
      if (!mountedRef.current) return
      if (entryReadGenerationRef.current.get(entryId) !== readGeneration) return
      applyOpenFiles(previous => {
        const current = previous[entryId]
        if (!current || current.generation !== generation) return previous
        return {
          ...previous,
          [entryId]: result.ok
            ? withDiskObserved(current, result.text, result.mtimeMs, result.version)
            : withAiWorkspaceReadError(current, result.error),
        }
      })
    },
    [applyOpenFiles],
  )

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
        // Invalidate any refresh read that began before this write. A
        // successful write performs a fresh read below; that closes the window
        // where invalidating an in-flight read could otherwise hide a newer
        // agent write that landed before IPC acknowledgement.
        entryReadGenerationRef.current.set(
          entryId,
          (entryReadGenerationRef.current.get(entryId) ?? 0) + 1,
        )
        const writtenText = buffer.currentText
        const result = await window.api
          .aiWorkspaceWriteFile({
            path: entry.path,
            text: writtenText,
            expectedVersion: options?.recreateDeleted ? null : buffer.diskVersion,
          })
          .catch(err => ({
            ok: false as const,
            error: err instanceof Error ? err.message : 'failed to save file',
            conflict: false,
            conflictKind: undefined,
          }))
        if (!result.ok) {
          entryReadGenerationRef.current.set(
            entryId,
            (entryReadGenerationRef.current.get(entryId) ?? 0) + 1,
          )
          applyOpenFiles(prev => {
            const current = prev[entryId]
            if (!current || current.generation !== buffer.generation) {
              return prev
            }
            return {
              ...prev,
              [entryId]: withError(
                current,
                result.error,
                result.conflict === true,
                result.conflictKind,
              ),
            }
          })
          return null
        }
        applyOpenFiles(prev => {
          const current = prev[entryId]
          if (!current || current.generation !== buffer.generation) return prev
          return {
            ...prev,
            [entryId]: withWriteAcknowledged(current, writtenText, result.mtimeMs, result.version),
          }
        })
        await revalidateEntryAfterWrite(entryId, entry.path, buffer.generation)
        if (mountedRef.current) void loadWorkspace()
        return { generation: buffer.generation, text: writtenText }
      })
    },
    [
      applyOpenFiles,
      currentOpenFiles,
      entriesById,
      loadWorkspace,
      revalidateEntryAfterWrite,
      serializeFileWrite,
    ],
  )

  const saveActive = useCallback(async () => {
    if (!activeFilePath) return
    await saveFile(activeFilePath)
  }, [activeFilePath, saveFile])

  const saveAll = useCallback(async () => {
    if (saveAllPendingRef.current) return
    const files = currentOpenFiles()
    const dirtyEntryIds = fileOrderRef.current.filter(entryId => files[entryId]?.dirty)
    if (dirtyEntryIds.length === 0) return
    saveAllPendingRef.current = true
    setSaveAllPending(true)
    try {
      // Keep the same bounded write behavior as project editing. Curated AI
      // workspaces can span many roots, so a broad review list is even more
      // likely to turn an unbounded fan-out into disk and IPC contention.
      const results = await mapWithConcurrency(dirtyEntryIds, 4, async entryId => ({
        entryId,
        saved: await saveFile(entryId),
      }))
      const firstFailure = results.find(result => !result.saved)
      if (firstFailure && mountedRef.current) setActiveFilePath(firstFailure.entryId)
    } finally {
      saveAllPendingRef.current = false
      if (mountedRef.current) setSaveAllPending(false)
    }
  }, [currentOpenFiles, saveFile])

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
        applyOpenFiles(prev => {
          const next = { ...prev }
          delete next[entryId]
          return next
        })
        fileOrderRef.current = nextOrder
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
      // still has this exact buffer lifetime mounted keeps its isolated undo
      // model alive; other editor surfaces intentionally use different models.
      if (buffer) releaseEditorModelOwner(buffer.generation)
      return true
    },
    [applyOpenFiles, currentOpenFiles, workspaceId],
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
        latest.currentText !== written.text ||
        hasRecoverableBufferChanges(latest)
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
      const readGeneration = (entryReadGenerationRef.current.get(entryId) ?? 0) + 1
      entryReadGenerationRef.current.set(entryId, readGeneration)
      const result = await window.api.aiWorkspaceReadFile(entry.path).catch(err => ({
        ok: false as const,
        error: err instanceof Error ? err.message : 'failed to reload file',
      }))
      if (entryReadGenerationRef.current.get(entryId) !== readGeneration) return
      applyOpenFiles(prev => {
        const current = prev[entryId]
        if (!current || current.generation !== before.generation) return prev
        if (!result.ok) {
          return { ...prev, [entryId]: withAiWorkspaceReadError(current, result.error) }
        }
        if (current.currentText !== before.currentText) {
          return {
            ...prev,
            [entryId]: withDiskObserved(current, result.text, result.mtimeMs, result.version),
          }
        }
        return {
          ...prev,
          [entryId]: withDiskSnapshot(current, result.text, result.mtimeMs, result.version),
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
        entryReadGenerationRef.current.set(
          entryId,
          (entryReadGenerationRef.current.get(entryId) ?? 0) + 1,
        )
        const writtenText = buffer.currentText
        const result = await window.api
          .aiWorkspaceWriteFile({
            path: entry.path,
            text: writtenText,
            expectedVersion: null,
          })
          .catch(err => ({
            ok: false as const,
            error: err instanceof Error ? err.message : 'failed to overwrite file',
            conflict: false,
            conflictKind: undefined,
          }))
        applyOpenFiles(prev => {
          const current = prev[entryId]
          if (!current || current.generation !== buffer.generation) return prev
          if (!result.ok) {
            return {
              ...prev,
              [entryId]: withError(
                current,
                result.error,
                result.conflict === true,
                result.conflictKind,
              ),
            }
          }
          return {
            ...prev,
            [entryId]: withWriteAcknowledged(current, writtenText, result.mtimeMs, result.version),
          }
        })
        if (result.ok) {
          await revalidateEntryAfterWrite(entryId, entry.path, buffer.generation)
        } else {
          entryReadGenerationRef.current.set(
            entryId,
            (entryReadGenerationRef.current.get(entryId) ?? 0) + 1,
          )
        }
        return result.ok
      })
    },
    [
      applyOpenFiles,
      currentOpenFiles,
      entriesById,
      revalidateEntryAfterWrite,
      serializeFileWrite,
    ],
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
          onRefresh={() => void refreshWorkspace()}
          onClose={onClose}
          onDetachEntry={entry => {
            void window.api
              .aiWorkspaceDetachFile({ workspaceId, entryId: entry.entryId })
              .catch(err =>
                setError(err instanceof Error ? err.message : 'Failed to remove attached file'),
              )
          }}
          onDeleteWorkspace={() => {
            if (Object.values(currentOpenFiles()).some(hasRecoverableBufferChanges)) {
              setError('Save or close unsaved tabs before deleting this AI Workspace.')
              return
            }
            void window.api
              .aiWorkspaceDelete(workspaceId)
              .catch(err =>
                setError(err instanceof Error ? err.message : 'Failed to delete AI Workspace'),
              )
          }}
        />
      }
      sidebarWidthPx={fileTreeWidthPx}
      sidebarVisible={fileTreeVisible}
      onSidebarWidthChange={setFileTreeWidthPx}
      fileOrder={fileOrder}
      openFiles={openFiles}
      activeFilePath={activeFilePath}
      activeFile={activeFile}
      lspContext={lspContextForEntry(
        workspaceId,
        activeFilePath ? entriesById.get(activeFilePath) : undefined,
        openAiDefinition,
      )}
      onActivateFile={(entryId, options) => {
        setActiveFilePath(entryId)
        if (!options.focusEditor) return
        applyOpenFiles(prev => {
          const current = prev[entryId]
          return current ? { ...prev, [entryId]: withFocusRequested(current) } : prev
        })
      }}
      onCloseFile={closeFile}
      onChangeFile={updateText}
      onSave={() => void saveActive()}
      onSaveAll={() => void saveAll()}
      saveAllPending={saveAllPending}
      onSaveThenClose={saveThenClose}
      onReloadFromDisk={entryId => void reloadFromDisk(entryId)}
      onOverwriteDisk={entryId => void overwriteDisk(entryId)}
      onFocusRequestHandled={entryId => {
        applyOpenFiles(prev => {
          const current = prev[entryId]
          if (!current || current.focusRequest === null) return prev
          return { ...prev, [entryId]: { ...current, focusRequest: null } }
        })
      }}
      onSelectionRevealed={entryId => {
        applyOpenFiles(prev => {
          const current = prev[entryId]
          if (!current?.selection) return prev
          return { ...prev, [entryId]: { ...current, selection: null } }
        })
      }}
      displayNameForPath={entryId => {
        const entry = entriesById.get(entryId)
        return entry?.title || (entry ? basename(entry.path) : 'Unknown file')
      }}
      titleForPath={entryId => entriesById.get(entryId)?.path ?? entryId}
      toolbarActions={toolbarActions}
    />
  )
}

function lspContextForEntry(
  workspaceId: string,
  entry: AiWorkspaceFileEntry | undefined,
  openDefinition: EditorLspContext['openDefinition'],
): EditorLspContext | null {
  if (!entry?.projectRoot) return null
  return {
    workspaceRoot: entry.projectRoot,
    filePath: null,
    authorization: {
      kind: 'ai-workspace',
      workspaceId,
      entryId: entry.entryId,
    },
    openDefinition,
  }
}
