import type { AgentProviderKind } from '@shared/types/providerKind.js'
import type { OpencodeUsageSource } from '@shared/types/providerEnablement.js'
import type { UsageProviderOk, UsageSourceId } from '@shared/types/usage.js'
import { readClaudeUsage } from '@main/usage/claudeUsage.js'
import { readCodexUsage } from '@main/usage/codexUsage.js'
import { readGrokUsage } from '@main/usage/grokUsage.js'

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

// null = the id is part of the contract but its reader has not landed
// (#1104 opencode:zai). A null entry is never listed active, so the modal
// cannot show a permanently-erroring row for work still in flight; that
// issue replaces the null with a descriptor.
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
  // #1104: the z.ai reader lands with Phase 3.
  'opencode:zai': null,
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
