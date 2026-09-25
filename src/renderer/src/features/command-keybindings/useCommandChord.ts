import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'

import { useAppStore } from '@renderer/app-state/hooks'
import { displayKeybinding, type Keybinding } from '@shared/keybindings'

import { resolveEffectiveKeybindings, type CommandKeybindingOverrides } from './resolve'

// Live chord lookup for UI that NAMES a command's shortcut (keyboard-first
// plan H4).
//
// WHY this exists: the sweep found ~16 UI strings with a chord typed in by
// hand — "New tab (⌘T)", "Open browser pocket (⌘⇧B)", "press ⌥↓ …", the
// "⌘⇧T Undo Close" toast. Every one of them lies the moment a user rebinds
// the command in Settings → Commands & Shortcuts, and the whole point of the
// keybinding store is that the chord is the USER's. StarterHintCard already
// resolved its chords live; this hook is the same resolution, reusable.
//
// WHY first binding only: a command may carry several (⌘W and ⌥W both close
// a pane). A hint shows one — the first, which is the primary chord in
// defaults.ts ordering and the one the palette shows (registry.ts takes the
// first binding for ResolvedCommand.shortcut too). Two hints that picked
// different bindings of the same command would be their own inconsistency.
//
// WHY null and not a fallback string: an unbound command has no chord, and a
// hint that invents one is the bug this replaces. Callers render nothing.

/**
 * First effective binding for `commandId` (defaults + the user's overrides),
 * in canonical form, or null when unbound. Pure; for non-React callers
 * (toasts built in workspace actions, command `when` reasons) that already
 * hold the overrides.
 */
export function commandBinding(
  commandId: string,
  overrides: CommandKeybindingOverrides | undefined,
): Keybinding | null {
  const entry = resolveEffectiveKeybindings(overrides ?? {}).find(item => item.commandId === commandId)
  return entry?.bindings[0] ?? null
}

/** Display form (`⌘⇧B`) of `commandBinding`, or null. */
export function commandChordLabel(
  commandId: string,
  overrides: CommandKeybindingOverrides | undefined,
): string | null {
  const binding = commandBinding(commandId, overrides)
  return binding ? displayKeybinding(binding) : null
}

/**
 * Store-reading form, for non-React code that has no overrides in hand.
 *
 * `getState().settings?.` — optional for the same reason StarterHintCard's
 * read is: test harnesses and the phone stub mount against a minimal store,
 * and degrading to the shipped defaults is the truthful answer there.
 */
export function currentCommandChordLabel(commandId: string): string | null {
  return commandChordLabel(commandId, useAppStore.getState().settings?.commandKeybindingOverrides)
}

/** React form: re-renders when the user rebinds. Returns the canonical binding. */
export function useCommandBinding(commandId: string): Keybinding | null {
  const overrides = useAppStore(useShallow(state => state.settings?.commandKeybindingOverrides ?? {}))
  return useMemo(() => commandBinding(commandId, overrides), [commandId, overrides])
}

/** React form of `commandChordLabel`, for `title` attributes and prose. */
export function useCommandChordLabel(commandId: string): string | null {
  const binding = useCommandBinding(commandId)
  return binding ? displayKeybinding(binding) : null
}

/** `"New Tab (⌘T)"`, or just `"New Tab"` when unbound — the tooltip idiom. */
export function withChord(label: string, chord: string | null): string {
  return chord ? `${label} (${chord})` : label
}
