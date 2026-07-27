import { panel } from '@renderer/features/command-palette/commandState'
import type { CommandDef } from '@renderer/features/command-palette/types'

export const remoteCommands: CommandDef[] = [
  {
    id: 'toggle-remote-panel',
    category: 'workspace-tools',
    pickerVisibility: 'experimental',
    surface: 'app',
    title: 'Remote Control',
    description:
      '**What it does:** Opens the **Remote Control** panel — enable the LAN server, pair your phone with a QR code, and manage paired devices.\n\n**Use when:** You want to watch agents, send prompts, or answer permission dialogs from your phone.\n\n**Notes:** Off by default. Phones can never run shell commands or start/stop sessions.',
    keywords: ['remote', 'phone', 'mobile', 'qr', 'pair', 'companion', 'lan'],
    // The store action was already a correct toggle. What was missing is the
    // badge — `remotePanelOpen` was the one panel flag absent from
    // CommandContext.flags, so this was the only panel command in the app
    // without an Open/Closed state while eleven siblings had one.
    getState: ({ flags }) => panel(flags.remotePanelOpen),
    run: ({ ui }) => ui.toggleRemotePanel(),
  },
]
