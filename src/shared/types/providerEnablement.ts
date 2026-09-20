import { AGENT_PROVIDER_KINDS, type AgentProviderKind } from './providerKind.js'

export const OPENCODE_USAGE_SOURCES = ['none', 'zai'] as const
export type OpencodeUsageSource = (typeof OPENCODE_USAGE_SOURCES)[number]

/**
 * Only the user's explicit on/off word persists (#1102). Detection is
 * recomputed from the toolchain every time enablement is resolved, so a
 * stored "detected" value could only ever go stale — an install/uninstall
 * after a Reset must be reflected without a migration.
 */
export type UserProviderOverrides = Partial<Record<AgentProviderKind, boolean>>

export type ProviderEnablementEntry = {
  kind: AgentProviderKind
  enabled: boolean
  /** Why this value holds — drives the settings row's hint text. */
  because: 'user' | 'detected' | 'not-detected'
  /** Whether a CLI was found on the last detection run (display only). */
  installed: boolean
}

export type ProviderEnablementSnapshot = {
  entries: Array<ProviderEnablementEntry>
  opencodeUsageSource: OpencodeUsageSource
}

export function coerceUserProviderOverrides(raw: unknown): UserProviderOverrides {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const result: UserProviderOverrides = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // Unknown keys and non-boolean values are dropped, not thrown on: a
    // hand-edited setup.json must not take the whole app down at load.
    if ((AGENT_PROVIDER_KINDS as readonly string[]).includes(key) && typeof value === 'boolean') {
      result[key as AgentProviderKind] = value
    }
  }
  return result
}

export function coerceOpencodeUsageSource(raw: unknown): OpencodeUsageSource {
  return raw === 'zai' ? 'zai' : 'none'
}

/**
 * WHY entries and not a map: the settings row renders one row per provider in
 * AGENT_PROVIDER_KINDS order with its reason attached, and the modal/pickers
 * only need the enabled set. An array preserves order once, at the source.
 */
export function resolveProviderEnablement(
  overrides: UserProviderOverrides,
  installed: ReadonlySet<AgentProviderKind>,
): Array<ProviderEnablementEntry> {
  return AGENT_PROVIDER_KINDS.map(kind => {
    const hasOverride = Object.prototype.hasOwnProperty.call(overrides, kind)
    const isInstalled = installed.has(kind)
    if (hasOverride) {
      return {
        kind,
        enabled: overrides[kind] === true,
        because: 'user' as const,
        installed: isInstalled,
      }
    }
    return {
      kind,
      enabled: isInstalled,
      because: isInstalled ? ('detected' as const) : ('not-detected' as const),
      installed: isInstalled,
    }
  })
}

export function enabledKindsFromEntries(
  entries: Array<ProviderEnablementEntry>,
): ReadonlySet<AgentProviderKind> {
  return new Set(entries.filter(entry => entry.enabled).map(entry => entry.kind))
}
