import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import type { EditorFileBuffer } from '@renderer/features/editor/types'
import { basename } from '@renderer/features/editor/lib/path'
import {
  SAVE_ACTIVE_EDITOR_FILE_EVENT,
  SAVE_ALL_EDITOR_FILES_EVENT,
} from '@renderer/features/editor/lib/editorCommandEvents'
import { ConfirmCloseDialog } from '@renderer/features/editor/ui/ConfirmCloseDialog'
import { EditorStatusBanner } from '@renderer/features/editor/ui/EditorStatusBanner'
import { EditorTabs } from '@renderer/features/editor/ui/EditorTabs'
import {
  MonacoFileEditor,
  type EditorLspContext,
} from '@renderer/features/editor/ui/MonacoFileEditor'
import { ResizableSidebar } from '@renderer/features/editor/ui/ResizableSidebar'

type EditorWorkbenchProps = {
  sidebar: ReactNode
  sidebarVisible?: boolean
  sidebarWidthPx: number
  onSidebarWidthChange: (widthPx: number) => void
  fileOrder: string[]
  openFiles: Record<string, EditorFileBuffer>
  activeFilePath: string | null
  activeFile: EditorFileBuffer | null
  lspContext: EditorLspContext | null
  onActivateFile: (path: string, options: { focusEditor: boolean }) => void
  /** Close a tab. Returns false when the buffer is dirty and the close
   *  was refused — the workbench then owns showing ConfirmCloseDialog and
   *  re-calling with `{ force: true }` on Discard. Hosts implement force
   *  semantics against their own store (Global Editor zustand / AI
   *  Workspace local state). */
  onCloseFile: (path: string, opts?: { force?: boolean }) => boolean
  onChangeFile: (path: string, text: string) => void
  onSave: () => void
  onSaveAll: () => void
  saveAllPending?: boolean
  /** Save the given file, then close it on success. Returns whether the
   *  save succeeded. Used by the dialog's "Save & Close"; when the host
   *  doesn't provide it the dialog falls back to a plain (refusable)
   *  close so the user still isn't stuck. */
  onSaveThenClose?: (path: string) => Promise<boolean>
  /** Conflict-banner actions — absent on hosts whose IO layer can't
   *  express them (the banner then shows the message only). */
  onReloadFromDisk?: (path: string) => void
  onOverwriteDisk?: (path: string) => void
  onSelectionRevealed?: (path: string) => void
  onFocusRequestHandled?: (path: string) => void
  displayNameForPath?: (path: string) => string
  titleForPath?: (path: string) => string
  toolbarActions?: ReactNode
}

// Shared editor workbench shell.
//
// WHY this owns only layout + close/error CHROME, not file loading:
// Global Editor and AI Workspace both look like "file source + tabs +
// Monaco", but their trust boundaries are different. Global Editor is
// rooted in one cwd and must go through editor-fs's root containment
// checks. AI Workspace is intentionally curated from absolute files
// across worktrees and goes through the AI Workspace registry. Forcing
// both through one filesystem API would either weaken containment or
// break the multi-root review workflow. This component shares the
// visual/editor mechanics — including the dirty-close confirm dialog and
// the save-error banner, which both surfaces used to get wrong
// independently — while each surface keeps its own IO adapter.
export function EditorWorkbench({
  sidebar,
  sidebarVisible = true,
  sidebarWidthPx,
  onSidebarWidthChange,
  fileOrder,
  openFiles,
  activeFilePath,
  activeFile,
  lspContext,
  onActivateFile,
  onCloseFile,
  onChangeFile,
  onSave,
  onSaveAll,
  saveAllPending = false,
  onSaveThenClose,
  onReloadFromDisk,
  onOverwriteDisk,
  onSelectionRevealed,
  onFocusRequestHandled,
  displayNameForPath = basename,
  titleForPath,
  toolbarActions,
}: EditorWorkbenchProps) {
  const [pendingClose, setPendingClose] = useState<{
    path: string
    generation: number
    focusTarget: 'editor' | 'tabs'
  } | null>(null)
  const [savingClose, setSavingClose] = useState(false)
  const [closeError, setCloseError] = useState<string | null>(null)
  const [focusAfterCloseEpoch, setFocusAfterCloseEpoch] = useState(0)
  const focusAfterCloseRef = useRef<{
    target: 'editor' | 'tabs'
    activePath: string | null
  } | null>(null)
  const workbenchRef = useRef<HTMLDivElement | null>(null)
  const onSaveRef = useRef(onSave)
  const onSaveAllRef = useRef(onSaveAll)
  onSaveRef.current = onSave
  onSaveAllRef.current = onSaveAll
  const openFilesRef = useRef(openFiles)
  const pendingCloseRef = useRef(pendingClose)
  openFilesRef.current = openFiles
  pendingCloseRef.current = pendingClose

  const closeRequestIsCurrent = useCallback(
    (request: NonNullable<typeof pendingClose>) =>
      pendingCloseRef.current === request &&
      openFilesRef.current[request.path]?.generation === request.generation,
    [],
  )

  useEffect(() => {
    if (!pendingClose) return
    if (openFiles[pendingClose.path]?.generation === pendingClose.generation) return
    // A workbench can stay mounted while its host switches cwd/workspace. A
    // relative path alone is therefore not enough identity for a destructive
    // dialog: "Discard src/index.ts" must never land on a new buffer that
    // happens to have the same path. Buffer generations are lifetime tokens.
    pendingCloseRef.current = null
    setPendingClose(null)
    setSavingClose(false)
    setCloseError(null)
  }, [openFiles, pendingClose])

  useEffect(() => {
    const save = () => onSaveRef.current()
    const saveAll = () => onSaveAllRef.current()
    window.addEventListener(SAVE_ACTIVE_EDITOR_FILE_EVENT, save)
    window.addEventListener(SAVE_ALL_EDITOR_FILES_EVENT, saveAll)
    return () => {
      window.removeEventListener(SAVE_ACTIVE_EDITOR_FILE_EVENT, save)
      window.removeEventListener(SAVE_ALL_EDITOR_FILES_EVENT, saveAll)
    }
  }, [])

  const activePathAfterClose = useCallback(
    (path: string): string | null => {
      if (activeFilePath !== path) return activeFilePath
      const closedIndex = fileOrder.indexOf(path)
      const nextOrder = fileOrder.filter(candidate => candidate !== path)
      return nextOrder[Math.min(closedIndex, nextOrder.length - 1)] ?? null
    },
    [activeFilePath, fileOrder],
  )

  const scheduleFocusAfterClose = useCallback(
    (target: 'editor' | 'tabs', activePath: string | null) => {
      focusAfterCloseRef.current = { target, activePath }
      setFocusAfterCloseEpoch(epoch => epoch + 1)
    },
    [],
  )

  useEffect(() => {
    const request = focusAfterCloseRef.current
    if (!request) return
    focusAfterCloseRef.current = null
    if (request.target === 'editor') {
      if (request.activePath) {
        onActivateFile(request.activePath, { focusEditor: true })
      } else {
        requestAnimationFrame(() => {
          workbenchRef.current?.querySelector<HTMLElement>('[data-editor-empty]')?.focus()
        })
      }
      return
    }
    requestAnimationFrame(() => {
      const selected = workbenchRef.current?.querySelector<HTMLButtonElement>(
        '[role="tab"][aria-selected="true"]',
      )
      const target =
        selected ?? workbenchRef.current?.querySelector<HTMLButtonElement>('[role="tab"]')
      target?.focus()
    })
  }, [activeFilePath, fileOrder, focusAfterCloseEpoch, onActivateFile])

  const restorePromptOrigin = useCallback(
    (path: string, target: 'editor' | 'tabs') => {
      if (target === 'editor') {
        onActivateFile(path, { focusEditor: true })
        return
      }
      requestAnimationFrame(() => {
        const tabs = [
          ...(workbenchRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []),
        ]
        tabs.find(tab => tab.dataset.editorPath === path)?.focus()
      })
    },
    [onActivateFile],
  )

  const requestClose = useCallback(
    (path: string, focusTarget: 'editor' | 'tabs') => {
      const nextActivePath = activePathAfterClose(path)
      const closed = onCloseFile(path)
      if (closed) {
        scheduleFocusAfterClose(focusTarget, nextActivePath)
        return
      }
      // Save failures are rendered for the active buffer. Activate the
      // requested tab before prompting so any subsequent error cannot end up
      // hidden behind a different tab.
      const generation = openFiles[path]?.generation
      if (generation == null) return
      onActivateFile(path, { focusEditor: false })
      setCloseError(null)
      setPendingClose({ path, generation, focusTarget })
    },
    [activePathAfterClose, onActivateFile, onCloseFile, openFiles, scheduleFocusAfterClose],
  )

  return (
    <div
      ref={workbenchRef}
      data-global-editor-input-owner="true"
      className="flex h-full min-h-0 min-w-0 overflow-hidden"
      onKeyDown={event => {
        if (event.defaultPrevented || event.nativeEvent.isComposing) return
        if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
        // Monaco owns the same chords through disposable editor actions. This
        // workbench handler exists for the rest of the editor chrome (tabs,
        // Explorer, and splitters), where allowing the workspace's window-level
        // Cmd+W handler through would terminate the underlying agent pane.
        if ((event.target as Element | null)?.closest('[data-global-editor-monaco]')) return
        const key = event.key.toLowerCase()
        if (key === 's') {
          event.preventDefault()
          onSave()
        } else if (key === 'w') {
          // Agent Code owns Cmd+W while focus is anywhere in editor chrome.
          // Even an empty workbench must consume it; otherwise Electron's
          // native menu receives the unhandled chord and closes the window.
          event.preventDefault()
          if (activeFilePath) {
            requestClose(
              activeFilePath,
              (event.target as Element | null)?.closest('[role="tablist"]') ? 'tabs' : 'editor',
            )
          }
        }
      }}
    >
      <ResizableSidebar
        visible={sidebarVisible}
        widthPx={sidebarWidthPx}
        onWidthChange={onSidebarWidthChange}
      >
        {sidebar}
      </ResizableSidebar>
      {/* `relative` so ConfirmCloseDialog's absolute scrim covers exactly
          the tabs+editor column — see the dialog's WHY on scoping. */}
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        <EditorTabs
          fileOrder={fileOrder}
          openFiles={openFiles}
          activeFilePath={activeFilePath}
          onActivate={onActivateFile}
          onClose={path => requestClose(path, 'tabs')}
          onSave={onSave}
          onSaveAll={onSaveAll}
          saveDisabled={!activeFile?.dirty}
          saveAllDisabled={
            saveAllPending || !Object.values(openFiles).some(file => file.dirty)
          }
          saveAllPending={saveAllPending}
          displayNameForPath={displayNameForPath}
          titleForPath={titleForPath}
          actions={toolbarActions}
        />
        {(activeFile?.error || activeFile?.surfaceWarning) && activeFilePath && (
          <EditorStatusBanner
            message={activeFile.error ?? activeFile.surfaceWarning ?? 'Editor warning'}
            conflict={activeFile.conflict}
            externalChange={activeFile.externalChange}
            onReload={onReloadFromDisk ? () => onReloadFromDisk(activeFilePath) : undefined}
            onOverwrite={onOverwriteDisk ? () => onOverwriteDisk(activeFilePath) : undefined}
          />
        )}
        <div
          role={activeFile ? 'tabpanel' : undefined}
          id={activeFile ? `editor-panel-${activeFile.generation}` : undefined}
          aria-labelledby={activeFile ? `editor-tab-${activeFile.generation}` : undefined}
          aria-label={activeFile ? undefined : 'No file open'}
          tabIndex={activeFile ? undefined : -1}
          data-editor-empty={activeFile ? undefined : 'true'}
          className="min-h-0 min-w-0 flex-1 overflow-hidden"
        >
          <MonacoFileEditor
            file={activeFile}
            lspContext={lspContext}
            onChange={onChangeFile}
            onSave={onSave}
            onClose={() => {
              if (activeFilePath) requestClose(activeFilePath, 'editor')
            }}
            onSelectionRevealed={onSelectionRevealed}
            onFocusRequestHandled={onFocusRequestHandled}
          />
        </div>
        {pendingClose && (
          <ConfirmCloseDialog
            fileName={displayNameForPath(pendingClose.path)}
            deleted={openFiles[pendingClose.path]?.externalChange === 'deleted'}
            saving={savingClose}
            error={closeError}
            onCancel={() => {
              const request = pendingClose
              pendingCloseRef.current = null
              setCloseError(null)
              setPendingClose(null)
              if (openFilesRef.current[request.path]?.generation === request.generation) {
                restorePromptOrigin(request.path, request.focusTarget)
              }
            }}
            onDiscard={() => {
              const request = pendingClose
              if (!closeRequestIsCurrent(request)) {
                pendingCloseRef.current = null
                setPendingClose(null)
                return
              }
              const nextActivePath = activePathAfterClose(request.path)
              const closed = onCloseFile(request.path, { force: true })
              if (!closed) return
              pendingCloseRef.current = null
              setPendingClose(null)
              scheduleFocusAfterClose(request.focusTarget, nextActivePath)
            }}
            onSaveAndClose={() => {
              void (async () => {
                if (savingClose) return
                const request = pendingClose
                if (!closeRequestIsCurrent(request)) {
                  pendingCloseRef.current = null
                  setPendingClose(null)
                  return
                }
                setSavingClose(true)
                try {
                  const nextActivePath = activePathAfterClose(request.path)
                  const saved = onSaveThenClose ? await onSaveThenClose(request.path) : false
                  // Saving crosses IPC and can outlive a cwd switch, tab close,
                  // or close-dialog replacement. Never let that late result
                  // dismiss/focus a newer dialog merely because paths match.
                  if (!closeRequestIsCurrent(request)) return
                  if (saved) {
                    pendingCloseRef.current = null
                    setCloseError(null)
                    setPendingClose(null)
                    scheduleFocusAfterClose(request.focusTarget, nextActivePath)
                    return
                  }
                  setCloseError(
                    openFilesRef.current[request.path]?.error ??
                      'The file changed while it was saving. Your newer edits are still open.',
                  )
                } catch (err) {
                  // IPC rejection is distinct from a structured write
                  // failure, but it has the same safety contract: leave the
                  // buffer and dialog open, make retry possible, and never
                  // strand the controls in a permanent "Saving…" state.
                  setCloseError(err instanceof Error ? err.message : 'Failed to save the file.')
                } finally {
                  setSavingClose(false)
                }
              })()
            }}
          />
        )}
      </div>
    </div>
  )
}
