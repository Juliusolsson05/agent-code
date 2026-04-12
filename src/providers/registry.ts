// Provider registry — the ONLY file the shell imports from src/providers/.
//
// This is the firewall between provider code and shell code. The shell
// calls getProvider(id) to look up a config; it never imports from
// ./claude/ or ./codex/ directly. That means a change inside one
// provider's directory physically cannot break the other provider or
// the shell — the import graph enforces it.

import type { ProviderConfig } from '../shared/types/providerConfig'
import { claudeConfig } from './claude/config'
import { codexConfig } from './codex/config'

const providers: Record<string, ProviderConfig> = {
  claude: claudeConfig,
  codex: codexConfig,
}

export function getProvider(id: string): ProviderConfig {
  const p = providers[id]
  if (!p) throw new Error(`Unknown provider: ${id}`)
  return p
}

export function getAllProviders(): ProviderConfig[] {
  return Object.values(providers)
}
