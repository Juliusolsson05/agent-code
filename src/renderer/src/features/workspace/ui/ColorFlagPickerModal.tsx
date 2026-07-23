import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { Button } from '@renderer/components/ui/button'
import { useAppStore } from '@renderer/app-state/hooks'
import {
  DISPATCH_COLOR_FLAGS,
  type ColorFlagId,
} from '@renderer/app-state/settings/dispatchColorFlags'
import type { SessionId } from '@renderer/workspace/types'

// The swatch picker for Dispatch color flags. Picking a swatch sets the flag and
// closes; "Clear flag" removes it. The strip itself renders on the Dispatch row
// (see DispatchAgentList). Kept intentionally tiny — this is a one-tap triage
// affordance, not a color editor.
export function ColorFlagPickerModal({
  open,
  sessionId,
  onClose,
}: {
  open: boolean
  sessionId: SessionId | null
  onClose: () => void
}) {
  // Read the CURRENT flag so the active swatch is ringed. Guard the null
  // sessionId (the modal is mounted-but-closed between opens).
  const currentFlagId = useAppStore(state =>
    sessionId ? state.settings.dispatchColorFlags[sessionId] : undefined,
  )
  const setDispatchColorFlag = useAppStore(state => state.setDispatchColorFlag)

  const choose = (colorId: ColorFlagId | null) => {
    if (sessionId) setDispatchColorFlag(sessionId, colorId)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent className="w-[360px] max-w-[calc(100vw-64px)]">
        <DialogHeader>
          <DialogTitle>Set color flag</DialogTitle>
          <DialogDescription>
            Mark this agent with a colored strip on the right edge of its
            Dispatch row so you can spot it in the list.
          </DialogDescription>
        </DialogHeader>

        {/* WHY the choice group is centered instead of inheriting the dialog's
            left edge: these swatches are one compact, peer-level choice—not a
            form field aligned beneath a label. The dialog primitive has no
            body padding of its own, so px-4 deliberately matches the header
            and footer inset while justify-center balances the unused width. */}
        <div
          data-color-flag-swatches="true"
          className="flex flex-wrap justify-center gap-3 px-4 py-2"
        >
          {DISPATCH_COLOR_FLAGS.map(flag => {
            const active = flag.id === currentFlagId
            return (
              <button
                key={flag.id}
                type="button"
                title={flag.label}
                aria-label={flag.label}
                aria-pressed={active}
                onClick={() => choose(flag.id)}
                className={`h-8 w-8 rounded-full transition-transform hover:scale-110 focus:outline-none ${
                  active
                    ? 'ring-2 ring-offset-2 ring-offset-surface ring-focus-ring'
                    : 'focus-visible:ring-2 focus-visible:ring-focus-ring'
                }`}
                style={{ backgroundColor: flag.color }}
              />
            )
          })}
        </div>

        <DialogFooter className="justify-between">
          <Button
            type="button"
            variant="outline"
            disabled={!currentFlagId}
            onClick={() => choose(null)}
          >
            Clear flag
          </Button>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
