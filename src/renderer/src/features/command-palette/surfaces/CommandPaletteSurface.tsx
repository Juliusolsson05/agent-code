import { CommandPalette } from '@renderer/features/command-palette/ui/CommandPalette'

// The palette is fully self-contained since #494 (store + workspace
// context); this wrapper just registry-lists it.
export function CommandPaletteSurface() {
  return <CommandPalette />
}
