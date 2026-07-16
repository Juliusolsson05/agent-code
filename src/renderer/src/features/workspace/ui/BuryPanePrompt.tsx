import { useEffect, useState } from 'react'

import { Button } from '@renderer/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Label } from '@renderer/components/ui/label'
import { Textarea } from '@renderer/components/ui/textarea'

type Props = {
  open: boolean
  title: string
  description: string
  onCancel: () => void
  onConfirm: (note: string) => void
}

export function BuryPanePrompt({
  open,
  title,
  description,
  onCancel,
  onConfirm,
}: Props) {
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!open) return
    setNote('')
  }, [open])

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onCancel()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bury Pane</DialogTitle>
          <DialogDescription asChild>
            <div>
              <div>{title}</div>
              <div className="mt-0.5 truncate text-[10px]">{description}</div>
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="px-4 py-4">
          <Label htmlFor="bury-pane-note" className="mb-2 block">
            Optional note
          </Label>
          <Textarea
            id="bury-pane-note"
            autoFocus
            rows={3}
            value={note}
            onChange={e => setNote(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                onConfirm(note)
              }
            }}
            className="min-h-0 resize-none bg-canvas"
            placeholder="Why did you bury this pane?"
          />
        </div>

        <DialogFooter>
          <Button
            type="button"
            onClick={onCancel}
            variant="outline"
          >
            Cancel
          </Button>
          {/* One confirm button. An empty textarea is the "skip the
              note" path — the store trims whitespace to undefined
              anyway. A separate "Skip Note" button that forced ''
              used to exist but did exactly the same thing as Bury
              with an empty field; users were just guessing which
              one to press. */}
          <Button
            type="button"
            onClick={() => onConfirm(note)}
          >
            Bury
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
