import type { ExtensionListEntry } from '@shared/types/extensions'
import { extensionThemeColorsSchema, extensionThemeMode } from '@shared/types/extensionThemes'
import { DEFAULT_CUSTOM_APPEARANCE, type CustomAppearanceColors } from './customAppearance'

export function installedThemeContributions(entries: readonly ExtensionListEntry[]) {
  // Keep this derived from the current catalog. Copying extension palettes into
  // savedThemes would sever update/uninstall ownership and let the editor mutate
  // data which the next install silently replaces. Only New theme makes a copy.
  return entries.filter(entry => entry.present).flatMap(entry =>
    (entry.manifest.contributes?.themes ?? []).flatMap(theme => {
      const parsed = extensionThemeColorsSchema.safeParse(theme.colors)
      if (!parsed.success || !theme.id.startsWith(`${entry.manifest.id}.`)) return []
      return [{ ...theme, colors: parsed.data, mode: extensionThemeMode(theme.id), extensionName: entry.manifest.name }]
    }),
  )
}

export function resolveExtensionThemeColors(entries: readonly ExtensionListEntry[], mode: string): CustomAppearanceColors | null {
  const theme = installedThemeContributions(entries).find(theme => theme.mode === mode)
  return theme ? { ...DEFAULT_CUSTOM_APPEARANCE, ...theme.colors } : null
}
