import { useMemo } from 'react'

import { useEnabledAgentProviderKinds } from '@renderer/features/providers/store'
import { useSkillsStore } from '@renderer/features/skills/store'
import type { AgentCodeConventionsTargetStatus } from '@shared/types/agentCodeConventions'
import { AGENT_PROVIDER_KINDS, type AgentProviderKind } from '@shared/types/providerKind'

/**
 * Providers that can hold personal skills, as main reports them. A provider
 * that main lists as unsupported (Grok today) never gets a column, so the
 * grid cannot offer a choice the filesystem cannot honour.
 */
export function useSupportedSkillProviders(): AgentProviderKind[] {
  const unsupported = useSkillsStore(state =>
    state.installed?.unsupportedProviders ?? state.custom?.unsupportedProviders ?? null)
  return useMemo(
    () => AGENT_PROVIDER_KINDS.filter(kind => !(unsupported ?? []).includes(kind)),
    [unsupported],
  )
}

/** The grid's columns: supported AND enabled in Settings → Providers (the MCP grid's rule). */
export function useSkillProviderColumns(): AgentProviderKind[] {
  const enabled = useEnabledAgentProviderKinds()
  const supported = useSupportedSkillProviders()
  return useMemo(() => supported.filter(kind => enabled.has(kind)), [supported, enabled])
}

/** What the user chose; an absent choice means every supported provider. */
export function chosenSkillProviders(
  providers: readonly AgentProviderKind[] | undefined,
  supported: readonly AgentProviderKind[],
): Set<AgentProviderKind> {
  return new Set(providers ?? supported)
}

/**
 * Providers whose agents can actually see the skill right now: everyone who
 * reads a root it is installed in.
 *
 * WHY this can be wider than the choice: roots are shared. OpenCode reads the
 * Claude root, and Codex and Pi share `~/.agents/skills`, so "Claude only"
 * is also visible to OpenCode. The grid says so instead of hiding it.
 */
export function visibleSkillProviders(targets: readonly AgentCodeConventionsTargetStatus[]): Set<AgentProviderKind> {
  return new Set(targets.filter(target => target.state === 'installed').flatMap(target => target.providers))
}

/**
 * The provider list to send after toggling one column, or `null` for "every
 * provider". Returns 'empty' when the toggle would leave no provider — that
 * is "turn it off", which the master switch does honestly.
 *
 * Toggling works on the FULL supported set rather than the visible columns,
 * so hiding a provider in Settings → Providers never silently drops it from a
 * skill's choice.
 */
export function toggledSkillProviders(
  providers: readonly AgentProviderKind[] | undefined,
  supported: readonly AgentProviderKind[],
  kind: AgentProviderKind,
  on: boolean,
): AgentProviderKind[] | null | 'empty' {
  const next = chosenSkillProviders(providers, supported)
  if (on) next.add(kind)
  else next.delete(kind)
  const list = supported.filter(provider => next.has(provider))
  if (list.length === 0) return 'empty'
  return list.length === supported.length ? null : list
}
