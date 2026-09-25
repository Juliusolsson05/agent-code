import { Button } from '@renderer/components/ui/button'
import { Kbd } from '@renderer/components/ui/kbd'
import { useCommandBinding } from '@renderer/features/command-keybindings/useCommandChord'

// Shown when there are zero tabs — either first launch before the
// default session spawns, or the user closed everything.
// (Moved verbatim from App.tsx by #494.)
//
// WHY the chord is resolved live: this read "new tab (⌘T)" as literal text,
// which kept promising ⌘T after a user rebound New Tab. The chip is the
// shared Kbd on the accent button (keyboard-first plan H2/H4), and the label
// is the command's own title-case name rather than a lowercase variant.
export function WelcomeEmpty({ onNewTabRequest }: { onNewTabRequest: () => void }) {
  const newTabBinding = useCommandBinding('new-tab')
  return (
    <div className="h-full flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="text-muted text-[12px]">No tabs open.</div>
        <Button type="button" onClick={onNewTabRequest}>
          New Tab
          {newTabBinding ? <Kbd binding={newTabBinding} tone="onAccent" /> : null}
        </Button>
      </div>
    </div>
  )
}
