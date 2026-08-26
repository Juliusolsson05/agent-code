import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { AGENT_TITLE_MAX_LENGTH } from '@renderer/workspace/agentTitle'

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

  const submit = (event: FormEvent) => {
    event.preventDefault()
    onSave(title)
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onCancel() }}>
      <DialogContent className="w-[440px] max-w-[calc(100vw-64px)]">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Set Agent Title</DialogTitle>
            <DialogDescription>
              {description || 'Give this agent a short glance label.'}
            </DialogDescription>
          </DialogHeader>

          <div className="px-4 py-4">
            <Label htmlFor="agent-title-input" className="mb-2 block">
              Title
            </Label>
            <Input
              id="agent-title-input"
              autoFocus
              maxLength={AGENT_TITLE_MAX_LENGTH}
              value={title}
              onChange={event => setTitle(event.target.value)}
              placeholder="e.g. Investigate queued prompt race"
            />
            <p className="mt-2 text-[10px] text-muted">
              Shown below the pane header and in the Dispatch index.
            </p>
          </div>

          <DialogFooter className="justify-between">
            <Button
              type="button"
              variant="outline"
              disabled={!initialTitle.trim() && !title.trim()}
              onClick={() => onSave('')}
            >
              Clear title
            </Button>
            <div className="flex items-center gap-2">
              <Button type="button" variant="outline" onClick={onCancel}>
                Cancel
              </Button>
              <Button type="submit">Save</Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
