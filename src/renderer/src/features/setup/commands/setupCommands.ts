import type { CommandDef } from '@renderer/features/command-palette/types'
import { panel } from '@renderer/features/command-palette/commandState'
import { useSetupStore } from '@renderer/features/setup/store'

export const setupCommands: CommandDef[] = [{
  // WHY this command exists (#995): the spawn error for a missing CLI says
  // "open Setup to locate it", and until now there was no Setup to open after
  // launch. The gate appeared once, from a local flag, and nothing could
  // bring it back. The File menu dispatches this same id
  // (NATIVE_MENU_COMMAND_IDS), so both roads lead to one surface.
  //
  // 'preferences' beside Open Settings: installing a provider or pointing
  // Agent Code at a CLI is configuration, and that is the drawer people open
  // when they are thinking about it.
  id: 'open-setup',
  category: 'preferences',
  surface: 'app',
  title: 'Open Setup',
  description: '**What it does:** Opens **Setup**: which agent CLIs and helper tools this Mac has, a copyable install command for each missing provider, and a manual path override.\n\n**Use when:** A provider is "not installed", a spawn says to open Setup, or you just installed a CLI and want Agent Code to find it.\n\n**Notes:** Opening it re-checks every tool. Escape closes it.',
  keywords: ['setup', 'install', 'provider', 'cli', 'claude', 'codex', 'opencode', 'grok', 'path', 'prerequisites', 'onboarding'],
  getState: () => panel(useSetupStore.getState().requested),
  run: ({ ui }) => {
    ui.closePalette()
    const store = useSetupStore.getState()
    if (store.requested) store.close()
    else store.open()
  },
}]
