import { CloseConfirmationDialog } from '@renderer/features/workspace/ui/CloseConfirmationDialog'

/** Always mounted: a close can be initiated from the palette, a chord, the tab
 *  button, the native menu, or programmatically, and the dialog must be able to
 *  answer whichever asked. */
export function CloseConfirmationSurface() {
  return <CloseConfirmationDialog />
}
