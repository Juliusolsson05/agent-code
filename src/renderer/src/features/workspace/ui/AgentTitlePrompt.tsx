import { useEffect, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { DialogActions } from '@renderer/components/ui/dialog-actions'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { limitAgentTitleLength } from '@renderer/workspace/agentTitle'

export function AgentTitlePrompt({
  open,
  initialTitle,
  description,
  onCancel,
  onSave,
}: {
  open: boolean
  initialTitle: string
  description: string
  onCancel: () => void
  onSave: (title: string) => void
}) {
  const [title, setTitle] = useState(initialTitle)

  useEffect(() => {
    if (open) setTitle(initialTitle)
  }, [initialTitle, open])

  // WHY no <form> any more: this was the only dialog that committed through
  // native form submission. DialogActions' buttons carry no `type`, so inside
  // a form Cancel would SUBMIT. DialogActions' own Enter listener gives the
  // same behaviour the form did — Enter in the title field saves, Enter on a
  // focused button presses that button — with the ↩ chip on Save saying so.
  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onCancel() }}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Set Title</DialogTitle>
          <DialogDescription>
            {description || 'Give this agent a short glance label.'}
          </DialogDescription>
        </DialogHeader>

        <div className="px-4 py-3">
          <Label htmlFor="agent-title-input" className="mb-2 block">
            Title
          </Label>
          <Input
            id="agent-title-input"
            autoFocus
            value={title}
            // WHY native maxLength is not used: browsers count UTF-16 code
            // units, while the durable title contract counts code points so
            // it never splits a surrogate pair. A native 120-unit limit
            // would allow only 60 emoji and disagree with save-time
            // normalization. Keep typing, paste, and persistence on the same
            // limiter instead.
            onChange={event => setTitle(limitAgentTitleLength(event.target.value))}
            placeholder="e.g. Investigate queued prompt race"
          />
          <p className="mt-2 text-[11px] text-muted">
            Shown below the pane header and in the Dispatch index.
          </p>
        </div>

        <DialogActions
          confirmLabel="Save"
          onConfirm={() => onSave(title)}
          onCancel={onCancel}
          extraActions={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              // Pushed to the far left of the button group: it is a different
              // KIND of action (remove the title), not a third way to answer.
              className="mr-auto"
              disabled={!initialTitle.trim() && !title.trim()}
              onClick={() => onSave('')}
            >
              Clear Title
            </Button>
          }
        />
      </DialogContent>
    </Dialog>
  )
}
