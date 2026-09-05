import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import {
  providerChoiceLabel,
  providerSwitchChoices,
  type AgentProviderChoice,
} from '@renderer/workspace/providerChoices'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import type { SessionId } from '@renderer/workspace/types'
import { isAgentProviderKind } from '@shared/types/providerKind'

type Props = {
  open: boolean
  sessionId: SessionId | null
  workspace: Workspace
  onClose: () => void
}

/** Explicit single-agent provider/runtime destination picker. */
export function ProviderSwitchPickerModal({
  open,
  sessionId,
  workspace,
  onClose,
}: Props) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const committingRef = useRef(false)
  const meta = sessionId ? workspace.state.sessions[sessionId] ?? null : null
  const sourceKind = isAgentProviderKind(meta?.kind) ? meta.kind : null
  const choices = useMemo(
    () => sourceKind ? providerSwitchChoices(sourceKind) : [],
    [sourceKind],
  )
  const [selectedIndex, setSelectedIndex] = useState(0)

  useEffect(() => {
    if (!open) return
    // A modal instance stays mounted across invocations. Reset both pieces of
    // one-shot state so a previous selection cannot suppress or preselect the
    // next agent's switch.
    setSelectedIndex(0)
    committingRef.current = false
  }, [open, sessionId, sourceKind])

  const selected = choices[selectedIndex] ?? null
  const choose = (choice: AgentProviderChoice) => {
    if (!sessionId || committingRef.current) return
    committingRef.current = true
    // Close before the potentially minutes-long compaction transaction. The
    // existing pane toast owns progress and errors; keeping a stale picker over
    // a pane whose local id is about to be replaced would invite a second
    // selection against dead state.
    onClose()
    void workspace.switchSessionProvider(
      sessionId,
      choice.kind,
      choice.providerRuntime,
    )
  }

  const moveSelection = (delta: -1 | 1) => {
    if (choices.length === 0) return
    setSelectedIndex(index => Math.max(0, Math.min(choices.length - 1, index + delta)))
  }

  const currentLabel = sourceKind
    ? providerChoiceLabel(sourceKind, meta?.providerRuntime)
    : 'Unavailable agent'
  const cwdBase = meta?.cwd.split('/').filter(Boolean).pop() ?? meta?.cwd ?? ''

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogContent
        ref={dialogRef}
        tabIndex={-1}
        onOpenAutoFocus={event => {
          event.preventDefault()
          dialogRef.current?.focus()
        }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')) {
            event.preventDefault()
            moveSelection(1)
            return
          }
          if (event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')) {
            event.preventDefault()
            moveSelection(-1)
            return
          }
          if (event.key === 'Enter' && selected) {
            event.preventDefault()
            choose(selected)
          }
        }}
        className="w-[500px] max-w-[calc(100vw-64px)]"
      >
        <DialogHeader>
          <DialogTitle>Switch Provider</DialogTitle>
          <DialogDescription asChild>
            <div>
              <div>Current: {currentLabel}{cwdBase ? ` · ${cwdBase}` : ''}</div>
              <div className="mt-0.5 text-[10px]">
                Choose where this conversation should continue.
              </div>
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-slab mx-4 my-4 overflow-hidden border border-border bg-canvas">
          {choices.length === 0 ? (
            <div className="px-3 py-8 text-center text-[12px] text-muted">
              This session has no available provider destinations.
            </div>
          ) : choices.map((choice, index) => {
            const focused = index === selectedIndex
            return (
              <button
                key={`${choice.kind}:${choice.providerRuntime ?? 'structured'}`}
                type="button"
                data-provider-switch-choice={`${choice.kind}:${choice.providerRuntime ?? 'structured'}`}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => choose(choice)}
                className={`
                  w-full border-b border-border px-3 py-3 text-left last:border-b-0
                  ${focused ? 'bg-accent/12' : 'bg-transparent hover:bg-surface'}
                  cursor-pointer
                `}
              >
                <div className="text-[12px] font-semibold text-ink">{choice.label}</div>
                <div className="mt-0.5 text-[11px] text-muted">{choice.description}</div>
              </button>
            )
          })}
        </div>

        <DialogFooter className="justify-between text-[11px] text-muted">
          <span>↑↓ choose · Enter switch · Esc cancel</span>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
