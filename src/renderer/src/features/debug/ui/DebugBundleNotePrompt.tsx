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
  bundlePath: string
  onCancel: () => void
  onConfirm: (note: string) => void
  // Optional label overrides so this same modal can back BOTH the debug-bundle
  // note and the Attach-Recording-Note flow (plan §7b) instead of forking a
  // second near-identical component. Defaults preserve the original
  // debug-bundle wording, so existing callers are unaffected. The footer path
  // line is only rendered when `bundlePath` is non-empty — a recording note
  // has no path to show.
  heading?: string
  placeholder?: string
  fieldLabel?: string
}

export function DebugBundleNotePrompt({
  open,
  title,
  description,
  bundlePath,
  onCancel,
  onConfirm,
  heading = 'Add Debug Bundle Note',
  placeholder = 'Why did you save this debug bundle?',
  fieldLabel = 'Optional note',
}: Props) {
  const [note, setNote] = useState('')

  useEffect(() => {
    if (!open) return
    setNote('')
  }, [open, bundlePath])

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) onCancel()
      }}
    >
      <DialogContent className="w-[min(560px,92vw)]">
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription asChild>
            <div>
              <div>{title}</div>
              <div className="mt-0.5 truncate text-[10px]">{description}</div>
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="px-4 py-4">
          <Label htmlFor="debug-bundle-note" className="mb-2 block">
            {fieldLabel}
          </Label>
          <Textarea
            id="debug-bundle-note"
            autoFocus
            rows={4}
            value={note}
            onChange={e => setNote(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                onConfirm(note)
              }
            }}
            className="min-h-0 resize-none bg-canvas"
            placeholder={placeholder}
          />
          {bundlePath ? (
            <div className="mt-2 truncate text-[10px] text-muted" title={bundlePath}>
              {bundlePath}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            onClick={onCancel}
            variant="outline"
          >
            Skip
          </Button>
          <Button
            type="button"
            onClick={() => onConfirm(note)}
          >
            Save Note
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
