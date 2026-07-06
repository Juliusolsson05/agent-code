import type { CommandDef } from '@renderer/features/command-palette/types'

export const remoteCommands: CommandDef[] = [
  {
    id: 'toggle-remote-panel',
    surface: 'app',
    title: 'Remote Control',
    description:
      '**What it does:** Opens the **Remote Control** panel — enable the LAN server, pair your phone with a QR code, and manage paired devices.\n\n**Use when:** You want to watch agents, send prompts, or answer permission dialogs from your phone.\n\n**Notes:** Off by default. Phones can never run shell commands or start/stop sessions.',
    keywords: ['remote', 'phone', 'mobile', 'qr', 'pair', 'companion', 'lan'],
    run: ({ ui }) => ui.toggleRemotePanel(),
  },
]
