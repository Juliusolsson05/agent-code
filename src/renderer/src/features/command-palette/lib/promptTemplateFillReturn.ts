import type { PaletteMode } from '@renderer/features/command-palette/paletteMode'

export type PromptTemplateFillReturnState = {
  mode: 'commands' | 'prompt-template'
  query: string
  selectedIndex: number
}

/**
 * Captures where Cancel/Escape should return after a variable-bearing template
 * opens the fill pane.
 *
 * WHY only top-level command search preserves its exact context: before mixed
 * search existed, every template flow intentionally returned to the dedicated
 * picker at its empty starting state. Preserving that behavior avoids changing
 * the established picker, while remembering command mode prevents the new
 * entry path from teleporting users into a surface they never opened.
 */
export function promptTemplateFillReturnState(
  originMode: PaletteMode,
  query: string,
  selectedIndex: number,
): PromptTemplateFillReturnState {
  return originMode === 'commands'
    ? { mode: 'commands', query, selectedIndex }
    : { mode: 'prompt-template', query: '', selectedIndex: 0 }
}
