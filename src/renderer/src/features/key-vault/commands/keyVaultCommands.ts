import type { CommandDef } from '@renderer/features/command-palette/types'

export const keyVaultCommands: CommandDef[] = [
  {
    id: 'api-key-vault',
    category: 'workspace-tools',
    surface: 'app',
    title: 'API Key Vault…',
    description:
      '**What it does:** Opens the **API Key Vault** — manage provider API keys, insert them into the focused pane, copy to clipboard, and reference them from prompt templates (`{{key:Provider/Key}}`).\n\n**Use when:** You regularly paste API keys (Brave, OpenAI, …) into agent prompts.\n\n**Notes:** Encrypted with the OS keyring; one Touch ID / password unlock per app launch.',
    keywords: ['api', 'key', 'vault', 'secret', 'credential', 'token', 'password'],
    run: ({ ui }) => {
      ui.openKeyVault()
    },
  },
]
