import type { SlashPickerState } from '@renderer/session-runtime/state'

// Layout & picker utilities for the workspace store.
//
// This module used to also hold the Tile Tabs sanitizer, ratio math, and the
// tile-tree divider walker. All of that died with the tile tree and Tile Tabs
// (#992): the stage's lane/row weights live in dispatch/gridShape.ts and have
// their own normalization. What is left is the pair of helpers that never
// depended on a tree.

/** Derive a tab title from a cwd — use the last path segment
 *  ("agent-code"), falling back to the full cwd if none. */
export function titleFromCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? cwd
}

/**
 * Cheap structural comparison for SlashPickerState. The picker object
 * itself is always fresh (parsed anew from each terminal snapshot in
 * main), so reference equality never holds — we have to look at the
 * visible flag, the item count, and the per-item id + selected bit.
 * IDs are short strings, items cap at ~15, so this runs in microseconds
 * and is still vastly cheaper than letting a no-op screen frame
 * propagate into a React render.
 */
export function pickerEqual(
  a: SlashPickerState,
  b: SlashPickerState,
): boolean {
  if (a.visible !== b.visible) return false
  if (a.items.length !== b.items.length) return false
  for (let i = 0; i < a.items.length; i++) {
    const x = a.items[i]
    const y = b.items[i]
    if (x.id !== y.id || x.selected !== y.selected) return false
  }
  return true
}
