import { useRef, useState } from 'react'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog'
import { DialogActions } from '@renderer/components/ui/dialog-actions'
import { Button } from '@renderer/components/ui/button'
import { KbdLegend } from '@renderer/components/ui/kbd'
import { useAppStore } from '@renderer/app-state/hooks'
import {
  DISPATCH_COLOR_FLAGS,
  type ColorFlagId,
} from '@renderer/app-state/settings/dispatchColorFlags'
import type { SessionId } from '@renderer/workspace/types'

// The swatch picker for color flags. Picking a swatch sets the flag and closes;
// "Clear Flag" removes it. The flag itself renders in two places: the Dispatch
// row's trailing strip (see DispatchColorFlagStrip) and the pane's session
// header (see PaneHeaderColorFlag). Kept intentionally tiny — this is a one-tap
// triage affordance, not a color editor.
//
// KEYBOARD (plan S9): the swatches are a WAI-ARIA radio group with ROVING
// tabindex — one Tab stop for the whole group, arrows move between swatches,
// Home/End jump, Enter/Space pick (the swatch is a real button, so activation
// is native). Before, every swatch was its own Tab stop and no arrow key did
// anything, so reaching the eighth colour took eight Tabs.
//
// WHY roving focus here and aria-activedescendant in the list dialogs: this
// group has no text input and each swatch is a real, independently
// activatable button, which is exactly the case roving tabindex is for (the
// EditorTabs strip uses it for the same reason). The list dialogs keep DOM
// focus on one owner so Enter can mean "commit the highlight".
//
// WHY arrows wrap and are linear in both axes: the swatches flex-wrap at a
// width that depends on the font, so "up" has no reliable column to land in;
// the radio-group pattern moves linearly on every arrow and wraps.
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
  const currentIndex = Math.max(0, DISPATCH_COLOR_FLAGS.findIndex(flag => flag.id === currentFlagId))
  const [focusIndex, setFocusIndex] = useState(currentIndex)
  const swatchRefs = useRef<Array<HTMLButtonElement | null>>([])

  const choose = (colorId: ColorFlagId | null) => {
    if (sessionId) setDispatchColorFlag(sessionId, colorId)
    onClose()
  }

  const focusSwatch = (index: number) => {
    const count = DISPATCH_COLOR_FLAGS.length
    const next = ((index % count) + count) % count
    setFocusIndex(next)
    swatchRefs.current[next]?.focus()
  }

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose() }}>
      <DialogContent
        size="sm"
        onOpenAutoFocus={event => {
          // Open ON the current flag (or the first swatch), so Enter-on-open
          // re-picks what is already set rather than changing it.
          event.preventDefault()
          setFocusIndex(currentIndex)
          swatchRefs.current[currentIndex]?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>Set Color Flag</DialogTitle>
          <DialogDescription>
            Mark this agent with a colored strip on the right edge of its
            Dispatch row so you can spot it in the list.
          </DialogDescription>
        </DialogHeader>

        {/* WHY the choice group is centered instead of inheriting the dialog's
            left edge: these swatches are one compact, peer-level choice—not a
            form field aligned beneath a label. px-4 matches the header and
            footer inset while justify-center balances the unused width. */}
        <div
          data-color-flag-swatches="true"
          role="radiogroup"
          aria-label="Color flag"
          className="flex flex-wrap justify-center gap-3 px-4 py-3"
          onKeyDown={event => {
            if (event.metaKey || event.ctrlKey || event.altKey) return
            const step =
              event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
                : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1
                  : 0
            if (step !== 0) {
              event.preventDefault()
              focusSwatch(focusIndex + step)
              return
            }
            if (event.key === 'Home' || event.key === 'End') {
              event.preventDefault()
              focusSwatch(event.key === 'Home' ? 0 : DISPATCH_COLOR_FLAGS.length - 1)
            }
          }}
        >
          {DISPATCH_COLOR_FLAGS.map((flag, index) => {
            const active = flag.id === currentFlagId
            return (
              <button
                key={flag.id}
                ref={element => { swatchRefs.current[index] = element }}
                type="button"
                role="radio"
                aria-checked={active}
                title={flag.label}
                aria-label={flag.label}
                tabIndex={index === focusIndex ? 0 : -1}
                onFocus={() => setFocusIndex(index)}
                onClick={() => choose(flag.id)}
                // CURRENT = an ink ring; FOCUS = the focus-ring outline. They
                // used to be the same ring-focus-ring, so the swatch you were
                // on and the swatch that was set were indistinguishable.
                className={`h-8 w-8 rounded-full outline-none transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus-ring ${
                  active ? 'ring-2 ring-ink ring-offset-2 ring-offset-surface' : ''
                }`}
                style={{ backgroundColor: flag.color }}
              />
            )
          })}
        </div>

        {/* Done only ever CLOSED, so it is the close-only footer's
            `Close ⎋` (plan H5). Clear Flag rides beside it; picking a swatch
            is Enter/Space on the focused swatch (legend). */}
        <DialogActions
          onCancel={onClose}
          cancelLabel="Close"
          legend={<KbdLegend items={[{ keys: ['Left', 'Right'], label: 'move' }, { keys: ['Enter'], label: 'pick' }]} />}
          extraActions={
            <Button type="button" variant="ghost" size="sm" disabled={!currentFlagId} onClick={() => choose(null)}>
              Clear Flag
            </Button>
          }
        />
      </DialogContent>
    </Dialog>
  )
}
