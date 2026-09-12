import { useEffect, useId, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'

type Props = {
  open: boolean
  /** Who is about to be granted root: title, provider and project, for the user to check. */
  agentLabel: string
  description: string
  onCancel: () => void
  onConfirm: () => void
}

/**
 * The gate in front of Root Agent Code Management (#906).
 *
 * WHY this is a dialog with an acknowledgement, not a plain toggle like the
 * other MCP commands: those grant an agent tools scoped to its own project.
 * This one grants the external operator's application-wide catalog, every
 * window, project, agent, terminal and layout, to a model that decides on its
 * own what to touch. The other toggles are reversible with one reload; this
 * one is too, but the damage a misread instruction can do in between is not.
 * The copy therefore says what is granted AND why the user probably does not
 * want it, and the confirm button stays disabled until the acknowledgement is
 * checked so a reflexive Enter cannot get past the warning.
 */
export function RootManagementConfirmDialog({
  open,
  agentLabel,
  description,
  onCancel,
  onConfirm,
}: Props) {
  const [acknowledged, setAcknowledged] = useState(false)
  const acknowledgementId = useId()

  useEffect(() => {
    // Every opening starts unacknowledged: a grant read and accepted for one
    // agent an hour ago says nothing about the agent in front of the user now.
    if (open) setAcknowledged(false)
  }, [open])

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        // Escape, the overlay and the close button all mean DECLINE. Nothing
        // is reloaded and the session keeps its current domains.
        if (!nextOpen) onCancel()
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Enable Root Agent Code Management?</DialogTitle>
          <DialogDescription asChild>
            <div>
              <div>{agentLabel}</div>
              <div className="mt-0.5 truncate text-[10px]">{description}</div>
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 px-4 py-3 text-[12px] leading-snug text-ink">
          <section>
            <h3 className="mb-1 text-[10px] uppercase tracking-wider text-muted">What this turns on</h3>
            <ul className="list-disc space-y-1 pl-4">
              <li>
                The same application-wide control an external operator has: every window, every
                project tab, every agent and terminal. Not only this agent&rsquo;s own project.
              </li>
              <li>
                Rearranging grids and Dispatch lanes; focusing, attaching, detaching, burying, pinning
                and titling agents; prompting, creating and closing agents and terminals; reading any
                conversation.
              </li>
              <li>
                Per agent and off by default. There is no Settings default. It stays on for this agent
                across reloads until you turn it off.
              </li>
            </ul>
          </section>

          <section>
            <h3 className="mb-1 text-[10px] uppercase tracking-wider text-danger">
              Why this is usually the wrong switch
            </h3>
            <ul className="list-disc space-y-1 pl-4">
              <li>
                Blast radius: one misread instruction can reorganize or close work in projects that have
                nothing to do with this agent&rsquo;s task.
              </li>
              <li>
                The model chooses what to touch. Closes still ask you first; layout changes and prompts
                to other agents do not.
              </li>
              <li>
                It exists for rare, supervised moments, such as reorganizing the workspace right after
                an audit you asked this agent to run. Turn it off when that moment ends.
              </li>
            </ul>
          </section>

          <label
            htmlFor={acknowledgementId}
            className="rounded-slab flex cursor-pointer items-start gap-2 border border-border bg-canvas px-2 py-2"
          >
            <input
              id={acknowledgementId}
              type="checkbox"
              className="mt-0.5"
              checked={acknowledged}
              onChange={event => setAcknowledged(event.target.checked)}
            />
            <span>I understand this agent can change or close work in every project in this app.</span>
          </label>

          <div className="text-[11px] text-muted">
            Enabling reloads this agent&rsquo;s process; its conversation resumes with the tools attached.
            Turning it off later reloads again without them.
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={!acknowledged}
            onClick={onConfirm}
          >
            Enable for this agent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
