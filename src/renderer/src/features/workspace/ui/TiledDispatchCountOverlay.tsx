import { useCallback, useRef, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { NumberInput } from '@renderer/components/ui/number-input'
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
  // Numeric state rather than the previous string: NumberInput owns parsing
  // and clamping, so keeping a string here would mean two places deciding what
  // "not a number yet" means.
  const [value, setValue] = useState<number>(existingCount ?? DEFAULT_DISPATCH_TILES)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const commit = useCallback(() => {
    const count = clampTileCount(value)
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
      }
    },
    [commit, onClose],
  )

  return (
    <Dialog open onOpenChange={nextOpen => {
      if (!nextOpen) onClose()
    }}>
      <DialogContent
        className="w-[320px]"
        // Radix's FocusScope runs focusFirst() on the first TABBABLE node after
        // mount — which is now the "−" stepper, not the field — and it runs
        // after any child autoFocus/ref, so a child cannot win this race.
        // Without taking the mount focus back here, typing goes nowhere and
        // Enter activates the stepper instead of committing.
        onOpenAutoFocus={event => {
          event.preventDefault()
          inputRef.current?.focus()
          inputRef.current?.select()
        }}
      >
        <DialogHeader>
          <DialogTitle>How many dispatch tiles?</DialogTitle>
          <DialogDescription className="text-[10px]">
            {MIN_DISPATCH_TILES}–{MAX_DISPATCH_TILES} lanes. The first lane is the
            full agent index; each other lane gets its own selector.
          </DialogDescription>
        </DialogHeader>
        {/* Was a bare <Input type="number"> relying on Chromium's native
            spinner arrows — ~8px, hover-only, stacked, and platform-dependent,
            which made "pick a lane count" a keyboard task for no reason other
            than the control. NumberInput gives it real +/- targets. */}
        <div className="mx-4 my-4" onKeyDown={onKeyDown}>
          <NumberInput
            id="tiled-dispatch-count"
            aria-label="Dispatch tile count"
            min={MIN_DISPATCH_TILES}
            max={MAX_DISPATCH_TILES}
            value={value}
            onChange={setValue}
            inputRef={inputRef}
          />
        </div>
        <DialogFooter>
          <Button
            type="button"
            onClick={onClose}
            variant="ghost"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={commit}
          >
            Open
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
