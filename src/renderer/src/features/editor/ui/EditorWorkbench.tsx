import { useCallback, useState, type ReactNode } from 'react'

import type { EditorFileBuffer } from '@renderer/features/editor/types'
import { basename } from '@renderer/features/editor/lib/path'
import { ConfirmCloseDialog } from '@renderer/features/editor/ui/ConfirmCloseDialog'
import { EditorStatusBanner } from '@renderer/features/editor/ui/EditorStatusBanner'
import { EditorTabs } from '@renderer/features/editor/ui/EditorTabs'
import { MonacoFileEditor } from '@renderer/features/editor/ui/MonacoFileEditor'
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
  lspContext: { workspaceRoot: string; filePath: string } | null
  onActivateFile: (path: string) => void
  /** Close a tab. Returns false when the buffer is dirty and the close
   *  was refused — the workbench then owns showing ConfirmCloseDialog and
   *  re-calling with `{ force: true }` on Discard. Hosts implement force
   *  semantics against their own store (Global Editor zustand / AI
   *  Workspace local state). */
  onCloseFile: (path: string, opts?: { force?: boolean }) => boolean
  onChangeFile: (path: string, text: string) => void
  onSave: () => void
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
  onSaveThenClose,
  onReloadFromDisk,
  onOverwriteDisk,
  onSelectionRevealed,
  onFocusRequestHandled,
}: EditorWorkbenchProps) {
  const [pendingClosePath, setPendingClosePath] = useState<string | null>(null)
  const [savingClose, setSavingClose] = useState(false)
  const [closeError, setCloseError] = useState<string | null>(null)

  const requestClose = useCallback(
    (path: string) => {
      const closed = onCloseFile(path)
      if (!closed) {
        // Save failures are rendered for the active buffer. Activate the
        // requested tab before prompting so any subsequent error cannot end up
        // hidden behind a different tab.
        onActivateFile(path)
        setCloseError(null)
        setPendingClosePath(path)
      }
    },
    [onActivateFile, onCloseFile],
  )

  return (
    <div className="flex h-full min-h-0 min-w-0 overflow-hidden">
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
          onClose={requestClose}
        />
        {activeFile?.error && activeFilePath && (
          <EditorStatusBanner
            message={activeFile.error}
            conflict={activeFile.conflict}
            externalChange={activeFile.externalChange}
            onReload={onReloadFromDisk ? () => onReloadFromDisk(activeFilePath) : undefined}
            onOverwrite={onOverwriteDisk ? () => onOverwriteDisk(activeFilePath) : undefined}
          />
        )}
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <MonacoFileEditor
            file={activeFile}
            lspContext={lspContext}
            onChange={onChangeFile}
            onSave={onSave}
            onClose={() => {
              if (activeFilePath) requestClose(activeFilePath)
            }}
            onSelectionRevealed={onSelectionRevealed}
            onFocusRequestHandled={onFocusRequestHandled}
          />
        </div>
        {pendingClosePath && (
          <ConfirmCloseDialog
            fileName={basename(pendingClosePath)}
            saving={savingClose}
            error={closeError}
            onCancel={() => {
              setCloseError(null)
              setPendingClosePath(null)
            }}
            onDiscard={() => {
              onCloseFile(pendingClosePath, { force: true })
              setPendingClosePath(null)
            }}
            onSaveAndClose={() => {
              void (async () => {
                if (savingClose) return
                setSavingClose(true)
                try {
                  const saved = onSaveThenClose ? await onSaveThenClose(pendingClosePath) : false
                  if (saved) {
                    setCloseError(null)
                    setPendingClosePath(null)
                    return
                  }
                  setCloseError(
                    openFiles[pendingClosePath]?.error ??
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
