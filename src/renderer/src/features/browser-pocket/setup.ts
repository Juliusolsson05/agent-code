import { providerSupportsBuiltInMcpDomain } from '@mcp/shared/types'
import type { AgentProviderKind } from '@shared/types/providerKind'
import type { Settings } from '@renderer/app-state/settings/types'

/** First use and Settings are the same operation. Opening a browser should
 * not send the user through an unrelated settings hunt, but turning it back
 * on must preserve any provider opt-outs made after initial setup. */
export function browserPocketEnablePatch(settings: Settings): Partial<Settings> {
  if (settings.browserPocketDefaultsInitialized) return { browserPocketEnabled: true }
  const defaults = { ...settings.defaultBuiltInMcpDomains }
  for (const kind of Object.keys(defaults) as AgentProviderKind[]) {
    if (!defaults[kind].includes('browser') && providerSupportsBuiltInMcpDomain(kind, 'browser')) defaults[kind] = [...defaults[kind], 'browser']
  }
  return { browserPocketEnabled: true, browserPocketDefaultsInitialized: true, defaultBuiltInMcpDomains: defaults }
}
