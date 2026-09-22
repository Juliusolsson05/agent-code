import { getRendererProviderCapabilities } from '@providers/registry.renderer.capabilities'
import { getProviderFeatures } from '@providers/shared/featureCapabilities'
import {
  AGENT_PROVIDER_KINDS,
  isAgentProviderKind,
  type AgentProviderKind,
  type AgentProviderRuntime,
} from '@shared/types/providerKind'
import type { SessionKind, SessionSpawnSelection } from '@renderer/workspace/types'

export type AgentProviderChoice = SessionSpawnSelection & {
  kind: AgentProviderKind
  label: string
  description: string
}

export type SessionSpawnChoice = SessionSpawnSelection & {
  kind: SessionKind
  label: string
  description: string
}

/**
 * Renderer-facing launch choices shared by create and provider-switch pickers.
 *
 * WHY this is not just `AGENT_PROVIDER_KINDS.map(...)`: OpenCode has two
 * intentionally distinct user choices backed by one provider identity. When
 * that expansion lived only inside NewAgentPlacementOverlay, every other
 * picker had to rediscover that `opencode + terminal runtime` is a real launch
 * destination. Centralizing the expansion keeps labels and runtime metadata
 * identical without lying to provider-level registries about a fourth kind.
 */
export const AGENT_PROVIDER_CHOICES: readonly AgentProviderChoice[] =
  AGENT_PROVIDER_KINDS.flatMap<AgentProviderChoice>(kind => {
    const capabilities = getRendererProviderCapabilities(kind)
    const structured: AgentProviderChoice = {
      kind,
      label: capabilities.shortLabel,
      description: capabilities.spawnDescription,
    }
    if (kind !== 'opencode') return [structured]
    return [
      structured,
      {
        kind: 'opencode',
        providerRuntime: 'terminal',
        label: 'OpenCode Terminal',
        description: 'native OpenCode TUI with Agent Code skills and MCP',
      },
    ]
  })

export const SESSION_SPAWN_CHOICES: readonly SessionSpawnChoice[] = [
  ...AGENT_PROVIDER_CHOICES,
  { kind: 'terminal', label: 'Terminal', description: 'plain shell pane' },
]

/** Choices backed by a declared source→target transcript edge. */
export function providerSwitchChoices(sourceKind: AgentProviderKind): AgentProviderChoice[] {
  const declaredTargets = new Set(getProviderFeatures(sourceKind).switchTargets)
  // Both OpenCode runtime choices survive when `opencode` is a declared
  // destination. Runtime flavor affects only the replacement spawn; the
  // transcript adapter and edge authorization remain provider-level facts.
  return AGENT_PROVIDER_CHOICES.filter(choice => declaredTargets.has(choice.kind))
}

export function providerChoiceLabel(
  kind: AgentProviderKind,
  providerRuntime?: AgentProviderRuntime,
): string {
  return kind === 'opencode' && providerRuntime === 'terminal'
    ? 'OpenCode Terminal'
    : getRendererProviderCapabilities(kind).shortLabel
}

import { enabledAgentProviderKindsSnapshot } from '@renderer/features/providers/store'

/**
 * Enablement filters (#1102). Pickers receive the filtered list; the static
 * exports above stay complete so non-picking consumers (validation cores,
 * keybinding defaults) can choose their own policy.
 */
export function filterAgentProviderChoices(
  choices: readonly AgentProviderChoice[],
  enabledKinds: ReadonlySet<AgentProviderKind>,
): AgentProviderChoice[] {
  return choices.filter(choice => enabledKinds.has(choice.kind))
}

export function filterSessionSpawnChoices(
  choices: readonly SessionSpawnChoice[],
  enabledKinds: ReadonlySet<AgentProviderKind>,
): SessionSpawnChoice[] {
  // `terminal` is not a provider: a user who disables every agent still
  // gets shells — enablement is a provider filter, not an app lockout.
  // extension-view can never appear in a spawn list but shares SessionKind,
  // so the isAgentProviderKind guard is what makes the narrowing honest.
  return choices.filter(
    choice =>
      choice.kind === 'terminal' ||
      (isAgentProviderKind(choice.kind) && enabledKinds.has(choice.kind)),
  )
}

export function enabledProviderSwitchChoices(
  sourceKind: AgentProviderKind,
  enabledKinds: ReadonlySet<AgentProviderKind>,
): AgentProviderChoice[] {
  // A disabled source has no valid destinations: switching away from a
  // provider the user turned off is how it sneaks back into the workspace.
  if (!enabledKinds.has(sourceKind)) return []
  return filterAgentProviderChoices(providerSwitchChoices(sourceKind), enabledKinds)
}

/** Non-React validation-core variant: reads the live store snapshot. */
export function enabledAgentProviderChoices(): AgentProviderChoice[] {
  return filterAgentProviderChoices(AGENT_PROVIDER_CHOICES, enabledAgentProviderKindsSnapshot())
}
