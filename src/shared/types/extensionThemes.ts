import { z } from 'zod'
import { CUSTOM_APPEARANCE_COLOR_KEYS } from '../appearanceColors.js'

// Third-party theme data enters the host's own CSS realm. A closed literal
// color grammar rules out network-bearing background values, variable cycles,
// escaped function names and declarations without needing a second CSS parser.
// Saved user themes keep their existing richer editor contract independently.
export const extensionThemeColorsSchema = z.partialRecord(
  z.enum(CUSTOM_APPEARANCE_COLOR_KEYS),
  z.string().regex(/^(?:#[0-9a-fA-F]{3}|#[0-9a-fA-F]{4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|transparent)$/),
).refine(colors => Object.keys(colors).length > 0, 'A theme must contribute at least one color')

export type ExtensionThemeContribution = {
  id: string
  title: string
  colors: z.infer<typeof extensionThemeColorsSchema>
}

// An extension theme is neither a built-in mode nor a user-editable saved
// theme. Preserve its identity while uninstalled so reinstall restores the
// selection; the current installed catalog alone decides which colors apply.
export const extensionThemeMode = (id: string): string => `extension-theme:${id}`
export function isExtensionThemeMode(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 112 &&
    /^extension-theme:[a-z][a-z0-9-]{0,63}(\.[a-zA-Z][a-zA-Z0-9-]*)+$/.test(value)
}
