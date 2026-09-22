import type { AgentProviderKind } from '@shared/types/providerKind.js'
import type { OpencodeUsageSource } from '@shared/types/providerEnablement.js'
import type { UsageProviderOk, UsageSourceId } from '@shared/types/usage.js'
import { readClaudeUsage } from '@main/usage/claudeUsage.js'
import { readCodexUsage } from '@main/usage/codexUsage.js'
import { readGrokUsage } from '@main/usage/grokUsage.js'
import { readZaiUsage } from '@main/usage/zaiUsage.js'

export type UsageSourceDescriptor = {
  id: UsageSourceId
  label: string
  sourceLabel: string
  read: () => Promise<UsageProviderOk>
}

export type UsageEnablementInput = {
  enabledKinds: ReadonlySet<AgentProviderKind>
  opencodeUsageSource: OpencodeUsageSource
}

export const USAGE_SOURCES: Record<UsageSourceId, UsageSourceDescriptor | null> = {
  claude: {
    id: 'claude',
    label: 'Claude',
    sourceLabel: 'Claude Code Keychain',
    read: readClaudeUsage,
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    sourceLabel: '~/.codex/auth.json',
    read: readCodexUsage,
  },
  grok: {
    id: 'grok',
    label: 'Grok',
    sourceLabel: '~/.grok/auth.json',
    read: readGrokUsage,
  },
  'opencode:zai': {
    id: 'opencode:zai',
    label: 'z.ai',
    sourceLabel: 'z.ai Coding Plan (OpenCode)',
    read: readZaiUsage,
  },
}

export function listActiveUsageSourceIds(input: UsageEnablementInput): UsageSourceId[] {
  const active: UsageSourceId[] = []
  for (const id of Object.keys(USAGE_SOURCES) as UsageSourceId[]) {
    if (!USAGE_SOURCES[id]) continue
    if (id === 'opencode:zai') {
      if (input.opencodeUsageSource === 'zai' && input.enabledKinds.has('opencode')) active.push(id)
      continue
    }
    if (input.enabledKinds.has(id)) active.push(id)
  }
  return active
}

export function listActiveUsageSources(
  input: UsageEnablementInput,
): Array<{ id: UsageSourceId; label: string }> {
  return listActiveUsageSourceIds(input)
    .map(id => {
      const descriptor = USAGE_SOURCES[id]
      return descriptor ? { id: descriptor.id, label: descriptor.label } : null
    })
    .filter((entry): entry is { id: UsageSourceId; label: string } => entry !== null)
}
