import { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { DialogActions } from '@renderer/components/ui/dialog-actions'
import { Kbd, KbdLegend } from '@renderer/components/ui/kbd'
import { useListNavigation } from '@renderer/lib/useListNavigation'
import {
  buildNewAgentInModel,
  type NewAgentInModel,
  type NewAgentInProject,
} from '@renderer/features/workspace/lib/newAgentInProjects'
import { AGENT_PROVIDER_CHOICES, filterAgentProviderChoices } from '@renderer/workspace/providerChoices'
import { useEnabledAgentProviderKinds } from '@renderer/features/providers/store'
import type { TabId } from '@renderer/workspace/types'
import type { Workspace } from '@renderer/workspace/workspaceStore'
import { withVisibleControls } from '@shared/text/visibleControls'
import { MISSING_PROVIDER_HINT, useMissingProviders } from '@renderer/features/setup/store'

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
  // The LISTBOX is the focus owner (focus-owner invariant, useListNavigation).
  const listRef = useRef<HTMLDivElement | null>(null)
  // One-shot latch around the spawn. `open` only drops once the parent reacts
  // to onClose, so a fast second Enter would otherwise start a second agent.
  // A ref, not state: it must gate the synchronous key handler, not re-render.
  const committingRef = useRef(false)
  const [step, setStep] = useState<Step>('agent')
  const missingProviders = useMissingProviders()
  // #1102: enablement filter — a disabled provider is not a creatable choice.
  const enabledKinds = useEnabledAgentProviderKinds()
  const providerChoices = useMemo(
    () => filterAgentProviderChoices(AGENT_PROVIDER_CHOICES, enabledKinds),
    [enabledKinds],
  )
  // The project the user picked the agent FOR starts highlighted; see
  // chooseAgent.
  const [initialProjectTabId, setInitialProjectTabId] = useState<TabId | null>(null)

  // Derived only while open. The surface is always mounted and re-renders on
  // every workspace change; the model walks every tab's sessions plus the
  // Dispatch rows, which is waste for a dialog nobody can see.
  const model = useMemo(
    () => (open ? buildNewAgentInModel(workspace.state) : CLOSED_MODEL),
    [open, workspace.state],
  )

  useEffect(() => {
    if (open) return
    // The instance survives between invocations, so every piece of one-shot
    // state resets. A leftover `project` step or a set latch would make the
    // next invocation start mid-flow or refuse to spawn at all.
    //
    // WHY on CLOSE rather than on open: an effect runs after the render it
    // belongs to, so resetting on open paints one frame of the previous
    // invocation's project step first. That frame is invisible when a click or
    // key opens the dialog, but not when something outside a user event does
    // (an MCP `commands.run`). Resetting while hidden means the first visible
    // frame is always the agent step.
    setStep('agent')
    setInitialProjectTabId(null)
    committingRef.current = false
  }, [open])

  // One shared-hook instance per step (plan K5). Both always exist (hooks
  // cannot be conditional); the key handler routes to the step's own.
  const agentNav = useListNavigation({
    count: providerChoices.length,
    resetKey: open,
    onActivate: index => chooseAgent(index),
    idPrefix: 'new-agent-in-choice',
  })
  // The highlighted project is held by TAB ID, not list index (`keys`): the
  // model is live while the dialog is open (an MCP operator can close an
  // agent or a tab meanwhile), and an index would silently slide onto a
  // different project when a row above it disappears. Disabled projects stay
  // visible (their reason is readable) but the highlight skips them: parked
  // on a disabled row, Enter would be a silent no-op that reads as broken.
  const projectKeys = useMemo(() => model.projects.map(project => project.tabId), [model.projects])
  const firstEnabledProject = Math.max(0, model.projects.findIndex(project => project.enabled))
  const initialProjectIndex = model.projects.findIndex(
    project => project.tabId === initialProjectTabId && project.enabled,
  )
  const projectNav = useListNavigation({
    count: model.projects.length,
    keys: projectKeys,
    // Re-seeded each time the project step is entered, on the project plain
    // New Agent… would have used (the model owns that rule), so accepting
    // both defaults lands in the same project.
    resetKey: `${open}:${step}:${initialProjectTabId}`,
    initialIndex: initialProjectIndex >= 0 ? initialProjectIndex : firstEnabledProject,
    isDisabled: index => !model.projects[index]?.enabled,
    onActivate: index => {
      const project = model.projects[index]
      if (project) commit(project)
    },
    idPrefix: 'new-agent-in-project',
  })
  const nav = step === 'agent' ? agentNav : projectNav

  const choice = providerChoices[Math.min(agentNav.index, providerChoices.length - 1)] ?? null
  const highlightedProject = model.projects[projectNav.index]?.enabled
    ? model.projects[projectNav.index]!
    : null

  function chooseAgent(index: number) {
    agentNav.setIndex(index)
    setStep('project')
    setInitialProjectTabId(model.initialTabId)
  }

  function commit(project: NewAgentInProject) {
    if (!choice || !project.enabled || committingRef.current) return
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

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogContent
        onOpenAutoFocus={event => {
          // Focus the LISTBOX, not the first row (a focused row button would
          // turn Enter into a native click on whichever row was first) and not
          // the dialog surface (aria-activedescendant only announces from the
          // focused element — focus-owner invariant, useListNavigation).
          //
          // Across steps the listbox element is the SAME node (only its rows
          // change), so focus survives the step change without an effect.
          event.preventDefault()
          listRef.current?.focus()
        }}
        onKeyDown={event => {
          if (event.key === 'Enter' && event.repeat) {
            // Held Enter auto-repeats. Without this one long press would pick
            // the agent and then commit the default project, starting a real
            // agent process the user never chose a project for. Swallowed
            // before the list sees it; a focused button is not affected
            // because the browser does not auto-repeat button activation.
            event.preventDefault()
            return
          }
          // ↑↓ / ⌃N⌃P / Home / End / PgUp / PgDn / Enter via the shared hook.
          // A FOCUSED BUTTON OWNS ITS OWN ENTER (#862): enforced inside the
          // hook with focusedControlOwnsEnter — without it Tab to Cancel +
          // Enter committed the highlighted project and SPAWNED an agent.
          if (nav.onKeyDown(event)) return
          if (event.key === 'Backspace' && step === 'project') {
            // Back, not cancel: picking the wrong agent should cost one key,
            // not the whole flow. The dialog has no text input, so Backspace
            // has nothing else it could mean here.
            event.preventDefault()
            setStep('agent')
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>New Agent In</DialogTitle>
          <DialogDescription>
            {step === 'agent' || !choice
              ? 'Choose the agent, then the project it starts in.'
              : `Choose the project for the new ${choice.label} agent.`}
          </DialogDescription>
        </DialogHeader>

        {/*
          ROWS ARE BUTTONS BUT NOT TAB STOPS (tabIndex -1 on both steps).
          Buttons, so a mouse click works and a disabled row is really
          disabled. Not tab stops, because keyboard selection here is the
          arrow-driven HIGHLIGHT, and a Tab-focused row splits it in two: the
          arrows move the highlight while DOM focus stays behind, and Space —
          which the browser delivers as a click on the FOCUSED button, with no
          way for an Enter handler to intercept it — then created the agent in
          a project other than the highlighted one (and picked a different
          agent on step one). With rows out of the tab order, keyboard focus is
          only ever on the dialog surface (arrows + Enter act on the highlight)
          or on the footer buttons (which own their own Enter and Space). A row
          can still take focus from a mouse click, but that click immediately
          advances the step or commits, so the split can never persist.
        */}
        <div className="px-4 py-3">
        <div
          ref={listRef}
          role="listbox"
          // One Tab stop (plan K4); rows are not (see above).
          tabIndex={0}
          aria-label={step === 'agent' ? 'Agent' : 'Project'}
          aria-activedescendant={nav.activeId}
          className="rounded-slab overflow-hidden border border-border bg-canvas outline-none focus-visible:border-focus-ring focus-visible:ring-1 focus-visible:ring-focus-ring"
        >
          {step === 'agent' ? (
            providerChoices.map((option, index) => {
              const focused = index === agentNav.index
              return (
                <button
                  key={`${option.kind}:${option.providerRuntime ?? 'structured'}`}
                  type="button"
                  {...agentNav.getItemProps(index)}
                  role="option"
                  aria-selected={focused}
                  tabIndex={-1}
                  data-new-agent-in-choice={`${option.kind}:${option.providerRuntime ?? 'structured'}`}
                  className={`
                    w-full cursor-pointer border-b border-l-2 border-border px-3 py-2 text-left last:border-b-0
                    ${focused ? 'border-l-accent bg-row-selected-bg' : 'border-l-transparent bg-transparent hover:bg-row-hover-bg'}
                  `}
                >
                  <div className="text-[12px] font-medium text-ink">{option.label}</div>
                  <div className="mt-0.5 text-[11px] text-muted">{missingProviders.has(option.kind) ? MISSING_PROVIDER_HINT : option.description}</div>
                </button>
              )
            })
          ) : model.projects.length === 0 ? (
            // The command needs an active tab, so an empty list can only mean
            // the focused row is bound solely to projects that have since been
            // closed (row bindings outlive their tab until #863 is fixed).
            // Saying "no projects are open" would be false and leave the user
            // stuck; name the control that fixes it instead.
            <div className="px-3 py-8 text-center text-[12px] text-muted">
              None of this row&rsquo;s projects are open. Change them with Row Projects&hellip;
            </div>
          ) : (
            model.projects.map((project, index) => {
              const focused = project.enabled && project.tabId === highlightedProject?.tabId
              return (
                <button
                  key={project.tabId}
                  type="button"
                  {...projectNav.getItemProps(index)}
                  role="option"
                  aria-selected={focused}
                  aria-disabled={!project.enabled || undefined}
                  tabIndex={-1}
                  // A real `disabled`, not a styled no-op: React drops clicks on
                  // it and assistive tech announces it, while the row (and its
                  // reason) stays in the list.
                  disabled={!project.enabled}
                  data-new-agent-in-project={project.tabId}
                  className={`
                    w-full border-b border-l-2 border-border px-3 py-2 text-left last:border-b-0
                    disabled:cursor-not-allowed disabled:opacity-50
                    ${focused ? 'border-l-accent bg-row-selected-bg' : 'border-l-transparent bg-transparent enabled:hover:bg-row-hover-bg'}
                    enabled:cursor-pointer
                  `}
                >
                  {/* Same "A · title" vocabulary as the Dispatch index and the
                      row-project picker, so a project has one name everywhere. */}
                  <div className="text-[12px] font-medium text-ink">
                    {withVisibleControls(`${project.label} · ${project.title}`)}
                  </div>
                  {project.disabledReason ? (
                    <div className="mt-0.5 text-[11px] text-muted">{project.disabledReason}</div>
                  ) : null}
                </button>
              )
            })
          )}
        </div>

        </div>

        {/* The prose legend ("↑↓ choose · Enter create · ⌫ back · Esc cancel")
            became chips on the controls that perform them (plan H2/H3):
            Back ⌫, Cancel ⎋, Next/Create ↩, with ↑↓ as the only legend item.
            Next/Create is new — Enter's meaning belongs on a button, and a
            mouse user gets a commit that is not "click the row".
            confirmOnEnter={false}: the list owns Enter (with the repeat guard
            above). */}
        <DialogActions
          confirmLabel={step === 'agent' ? 'Next' : 'Create'}
          onConfirm={() => {
            if (step === 'agent') chooseAgent(agentNav.index)
            else if (highlightedProject) commit(highlightedProject)
          }}
          onCancel={onClose}
          confirmOnEnter={false}
          confirmDisabled={step === 'agent' ? !choice : !highlightedProject}
          legend={<KbdLegend items={[{ keys: ['Up', 'Down'], label: 'move' }]} />}
          extraActions={step === 'project' ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setStep('agent')}>
              Back
              <Kbd binding="Backspace" />
            </Button>
          ) : null}
        />
      </DialogContent>
    </Dialog>
  )
}
