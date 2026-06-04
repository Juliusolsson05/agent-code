import { useCallback, useEffect, useRef, useState } from 'react'

import type { Workspace } from '@renderer/workspace/workspaceStore'
import {
  clampTileCount,
  DEFAULT_DISPATCH_TILES,
  MAX_DISPATCH_TILES,
  MIN_DISPATCH_TILES,
} from '@renderer/workspace/dispatch/tiledDispatchSelectors'

// The "How many dispatch tiles?" prompt. A small self-contained modal
// rather than a command-palette mode — the palette's mode union + props is
// a large prop-drilled state machine, and a one-field numeric prompt is
// cleaner and lower-risk as its own overlay (mirrors NewAgentPlacementOverlay).
//
// On confirm we route through workspace.enterTiledDispatch (which clamps
// again and auto-fills lanes). If a tiled layout is already active we resize
// it via setTiledLaneCount so re-running the command is the "change the
// count" path the issue asks for, preserving existing lane selections.
//
// We deliberately do NOT use window.prompt/confirm — Electron modal dialogs
// block the renderer's event loop and the project's browser-automation
// guidance forbids them.

type Props = {
  workspace: Workspace
  onClose: () => void
}

export function TiledDispatchCountOverlay({ workspace, onClose }: Props) {
  // Default to the current tile count when re-prompting an active tiled
  // layout, otherwise the standard default. Lets the user nudge the count
  // without re-typing it from scratch.
  const existingCount = workspace.state.dispatchMode?.tiled?.lanes.length
  const [value, setValue] = useState<string>(
    String(existingCount ?? DEFAULT_DISPATCH_TILES),
  )
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  const commit = useCallback(() => {
    const count = clampTileCount(Number(value))
    if (workspace.state.dispatchMode?.tiled) {
      workspace.setTiledLaneCount(count)
    } else {
      void workspace.enterTiledDispatch(count)
    }
    onClose()
  }, [value, workspace, onClose])

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        commit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    },
    [commit, onClose],
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onMouseDown={onClose}
    >
      <div
        className="w-[320px] border border-border bg-surface p-4 shadow-xl"
        onMouseDown={e => e.stopPropagation()}
      >
        <label
          htmlFor="tiled-dispatch-count"
          className="block text-[12px] text-ink"
        >
          How many dispatch tiles?
        </label>
        <p className="mt-1 text-[10px] text-muted">
          {MIN_DISPATCH_TILES}–{MAX_DISPATCH_TILES} lanes. The first lane is the
          full agent index; each other lane gets its own selector.
        </p>
        <input
          id="tiled-dispatch-count"
          ref={inputRef}
          type="number"
          min={MIN_DISPATCH_TILES}
          max={MAX_DISPATCH_TILES}
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          className="mt-3 w-full border border-border bg-canvas px-2 py-1 text-[13px] text-ink tabular-nums outline-none focus:border-accent"
        />
        <div className="mt-4 flex justify-end gap-2 text-[12px]">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 text-muted hover:text-ink"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={commit}
            className="border border-accent bg-accent/15 px-3 py-1 text-accent hover:bg-accent/25"
          >
            Open
          </button>
        </div>
      </div>
    </div>
  )
}
