import { useEffect, useState } from 'react'

import { requestConfirm } from '@renderer/components/ui/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { DialogActions } from '@renderer/components/ui/dialog-actions'
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

  // A typed note is REAL input (B7's condition on plan D3): Skip, Escape and
  // an outside click all route here, and with text in the box they ask
  // before throwing it away. An empty note skips at once — asking then would
  // be a speed bump on the common "no note" path.
  const skip = async () => {
    if (note.trim() && !(await requestConfirm({
      title: 'Discard this note?',
      description: 'The bundle stays saved; only the note is lost.',
      confirmLabel: 'Discard Note',
      tone: 'danger',
    }))) return
    onCancel()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={nextOpen => {
        if (!nextOpen) void skip()
      }}
    >
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>{heading}</DialogTitle>
          <DialogDescription asChild>
            <div>
              <div>{title}</div>
              <div className="mt-0.5 truncate text-[10px]">{description}</div>
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="px-4 py-3">
          <Label htmlFor="debug-bundle-note" className="mb-2 block">
            {fieldLabel}
          </Label>
          <Textarea
            id="debug-bundle-note"
            autoFocus
            rows={4}
            value={note}
            onChange={e => setNote(e.target.value)}
            // ⌘↩ saves — wired by DialogActions' confirmKey below (it was a
            // hand-rolled handler here, the drift DialogActions' header
            // records). Plain Enter stays a newline.
            className="min-h-0 resize-none bg-canvas"
            placeholder={placeholder}
          />
          {bundlePath ? (
            <div className="mt-2 truncate text-[10px] text-muted" title={bundlePath}>
              {bundlePath}
            </div>
          ) : null}
        </div>

        {/* WHY "Skip" and not the house "Cancel": the bundle is ALREADY saved
            when this opens; this button declines only the note. "Cancel"
            would read as "don't save the bundle", which is not what happens
            (DialogActions' header lists "Skip" as drift — that was about
            labels naming a key; this one names the real action). */}
        <DialogActions
          confirmLabel="Save Note"
          confirmKey="Cmd+Enter"
          onConfirm={() => onConfirm(note)}
          onCancel={() => void skip()}
          cancelLabel="Skip"
        />
      </DialogContent>
    </Dialog>
  )
}
