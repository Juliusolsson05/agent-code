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
  buildNewAgentInModel,
  type NewAgentInModel,
  type NewAgentInProject,
} from '@renderer/features/workspace/lib/newAgentInProjects'
import { AGENT_PROVIDER_CHOICES } from '@renderer/workspace/providerChoices'
import type { TabId } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'

type Props = {
  open: boolean
  workspace: Workspace
  onClose: () => void
}

type Step = 'agent' | 'project'

// Shared empty model so a closed dialog hands the same reference to every
// render instead of allocating one per workspace change.
const CLOSED_MODEL: NewAgentInModel = { projects: [], initialTabId: null }

/**
 * New Agent In… (#852): choose an agent, then the project it starts in.
 *
 * WHY a dedicated dialog rather than another mode on NewAgentPlacementOverlay:
 * that overlay already carries four intents (create, attach, linked, header
 * project) and treats "a kind has been picked" as "now show grid placement".
 * A second, project step would have to be one more special case inside that
 * invariant. The palette was the other candidate, but a two-step choice there
 * needs the first answer held in store state across palette modes. This file
 * is the whole feature's UI, and it composes `DialogContent` so Escape, the
 * focus trap, outside-click and app input ownership come from the one
 * primitive that owns them (components/ui/README.md).
 *
 * WHY no lane choice here: the spawn keeps New Agent…'s lane semantics — the
 * agent fills the FOCUSED lane (`createDetachedDispatchAgent` keeps the
 * focus-derived laneIndex even under a project override). The user's workflow
 * is "focus the empty lane, fill it", so the lane is already chosen.
 */
export function NewAgentInDialog({ open, workspace, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement | null>(null)
  // One-shot latch around the spawn. `open` only drops once the parent reacts
  // to onClose, so a fast second Enter would otherwise start a second agent.
  // A ref, not state: it must gate the synchronous key handler, not re-render.
  const committingRef = useRef(false)
  const [step, setStep] = useState<Step>('agent')
  const [agentIndex, setAgentIndex] = useState(0)
  // The highlighted project is held by TAB ID, not list index: the model is
  // live while the dialog is open (an MCP operator can close an agent or a
  // tab meanwhile), and an index would silently slide onto a different
  // project when a row above it disappears.
  const [projectTabId, setProjectTabId] = useState<TabId | null>(null)

  // Derived only while open. The surface is always mounted and re-renders on
  // every workspace change; the model walks every tab's sessions plus the
  // Dispatch rows, which is waste for a dialog nobody can see.
  const model = useMemo(
    () => (open ? buildNewAgentInModel(workspace.state) : CLOSED_MODEL),
    [open, workspace.state],
  )

  useEffect(() => {
    if (!open) return
    // The instance survives between invocations, so every piece of one-shot
    // state resets on open. A leftover `project` step or a set latch would make
    // the next invocation start mid-flow or refuse to spawn at all.
    setStep('agent')
    setAgentIndex(0)
    setProjectTabId(null)
    committingRef.current = false
  }, [open])

  useEffect(() => {
    if (!open) return
    // Keep keyboard focus on the dialog surface across steps. Choosing a row
    // with the mouse focuses that row's button, and switching steps unmounts
    // it; without this the next arrow key would have nothing listening.
    dialogRef.current?.focus()
  }, [open, step])

  const choice = AGENT_PROVIDER_CHOICES[agentIndex] ?? null
  const enabledProjects = model.projects.filter(project => project.anchorSessionId !== null)
  const highlightedProject =
    enabledProjects.find(project => project.tabId === projectTabId) ?? null

  const chooseAgent = (index: number) => {
    setAgentIndex(index)
    setStep('project')
    // Start on the project plain New Agent… would have used (the model owns
    // that rule), so accepting both defaults never does worse than today.
    setProjectTabId(model.initialTabId)
  }

  const commit = (project: NewAgentInProject) => {
    if (!choice || !project.anchorSessionId || committingRef.current) return
    committingRef.current = true
    // Close before the spawn: it awaits an IPC round trip, and the agent is
    // about to appear in the lane underneath. createDetachedDispatchAgent owns
    // failure feedback (toasts), exactly as it does for New Agent… and the
    // project header's "+".
    onClose()
    void workspace.createDetachedDispatchAgent(
      { kind: choice.kind, providerRuntime: choice.providerRuntime },
      { tabId: project.tabId, anchorSessionId: project.anchorSessionId },
    )
  }

  const moveAgent = (delta: -1 | 1) => {
    setAgentIndex(index =>
      Math.max(0, Math.min(AGENT_PROVIDER_CHOICES.length - 1, index + delta)),
    )
  }

  const moveProject = (delta: -1 | 1) => {
    // Arrows walk ENABLED projects only. A highlight parked on a disabled row
    // turns Enter into a silent no-op, which reads as a broken dialog; the
    // disabled row stays visible so its reason is still readable.
    if (enabledProjects.length === 0) return
    const current = enabledProjects.findIndex(project => project.tabId === projectTabId)
    const next = current < 0
      ? 0
      : Math.max(0, Math.min(enabledProjects.length - 1, current + delta))
    setProjectTabId(enabledProjects[next]!.tabId)
  }

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
          // Focus the surface itself, not the first row: the key handler lives
          // here, and a focused row button would also turn Enter into a native
          // click on whichever row happened to be first.
          event.preventDefault()
          dialogRef.current?.focus()
        }}
        onKeyDown={event => {
          const down = event.key === 'ArrowDown' || (event.ctrlKey && event.key === 'n')
          const up = event.key === 'ArrowUp' || (event.ctrlKey && event.key === 'p')
          if (down || up) {
            event.preventDefault()
            if (step === 'agent') moveAgent(down ? 1 : -1)
            else moveProject(down ? 1 : -1)
            return
          }
          if (event.key === 'Enter') {
            // preventDefault also cancels a focused button's native Enter-click,
            // so a Tab-focused row cannot fire a second, different action.
            event.preventDefault()
            if (step === 'agent') chooseAgent(agentIndex)
            else if (highlightedProject) commit(highlightedProject)
            return
          }
          if (event.key === 'Backspace' && step === 'project') {
            // Back, not cancel: picking the wrong agent should cost one key,
            // not the whole flow. The dialog has no text input, so Backspace
            // has nothing else it could mean here.
            event.preventDefault()
            setStep('agent')
          }
        }}
        className="w-[500px] max-w-[calc(100vw-64px)]"
      >
        <DialogHeader>
          <DialogTitle>New Agent In</DialogTitle>
          <DialogDescription>
            {step === 'agent' || !choice
              ? 'Choose the agent, then the project it starts in.'
              : `Choose the project for the new ${choice.label} agent.`}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-slab mx-4 my-4 overflow-hidden border border-border bg-canvas">
          {step === 'agent' ? (
            AGENT_PROVIDER_CHOICES.map((option, index) => {
              const focused = index === agentIndex
              return (
                <button
                  key={`${option.kind}:${option.providerRuntime ?? 'structured'}`}
                  type="button"
                  data-new-agent-in-choice={`${option.kind}:${option.providerRuntime ?? 'structured'}`}
                  onMouseEnter={() => setAgentIndex(index)}
                  onFocus={() => setAgentIndex(index)}
                  onClick={() => chooseAgent(index)}
                  className={`
                    w-full cursor-pointer border-b border-border px-3 py-3 text-left last:border-b-0
                    ${focused ? 'bg-accent/12' : 'bg-transparent hover:bg-surface'}
                  `}
                >
                  <div className="text-[12px] font-semibold text-ink">{option.label}</div>
                  <div className="mt-0.5 text-[11px] text-muted">{option.description}</div>
                </button>
              )
            })
          ) : model.projects.length === 0 ? (
            <div className="px-3 py-8 text-center text-[12px] text-muted">
              No projects are open.
            </div>
          ) : (
            model.projects.map(project => {
              const enabled = project.anchorSessionId !== null
              const focused = enabled && project.tabId === highlightedProject?.tabId
              return (
                <button
                  key={project.tabId}
                  type="button"
                  // A real `disabled`, not a styled no-op: React drops clicks on
                  // it and assistive tech announces it, while the row (and its
                  // reason) stays in the list.
                  disabled={!enabled}
                  data-new-agent-in-project={project.tabId}
                  onMouseEnter={() => { if (enabled) setProjectTabId(project.tabId) }}
                  onFocus={() => { if (enabled) setProjectTabId(project.tabId) }}
                  onClick={() => commit(project)}
                  className={`
                    w-full border-b border-border px-3 py-3 text-left last:border-b-0
                    disabled:cursor-not-allowed disabled:opacity-50
                    ${focused ? 'bg-accent/12' : 'bg-transparent enabled:hover:bg-surface'}
                    enabled:cursor-pointer
                  `}
                >
                  {/* Same "A · title" vocabulary as the Dispatch index and the
                      row-project picker, so a project has one name everywhere. */}
                  <div className="text-[12px] font-semibold text-ink">
                    {`${project.label} · ${project.title}`}
                  </div>
                  {project.disabledReason ? (
                    <div className="mt-0.5 text-[11px] text-muted">{project.disabledReason}</div>
                  ) : null}
                </button>
              )
            })
          )}
        </div>

        <DialogFooter className="justify-between text-[11px] text-muted">
          <span>
            {step === 'agent'
              ? '↑↓ choose · Enter next · Esc cancel'
              : '↑↓ choose · Enter create · ⌫ back · Esc cancel'}
          </span>
          <div className="flex gap-2">
            {step === 'project' ? (
              <Button type="button" variant="ghost" onClick={() => setStep('agent')}>
                Back
              </Button>
            ) : null}
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
