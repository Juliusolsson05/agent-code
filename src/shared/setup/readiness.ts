import {
  AGENT_PROVIDER_KINDS,
  DEFAULT_PROVIDER,
  type AgentProviderKind,
} from '@shared/types/providerKind.js'
import type { SetupCheckResult, SetupToolId, SetupToolStatus } from '@shared/types/setup.js'

/**
 * First-run readiness: the ONE place that turns probed tool rows into "what
 * can this machine run, and what does a fresh install open with" (#995).
 *
 * WHY a single module: before #995 the answer was spread across three
 * consumers that each re-derived it. The gate read `required` flags, the
 * bootstrap assumed Claude, and the spawn path discovered the truth last, by
 * throwing. They disagreed exactly when it mattered: on a clean Mac the gate
 * blocked, the bootstrap spawned Claude underneath it anyway, the spawn failed,
 * and the run was left with no tabs and autosave off.
 *
 * ISOLATION: production code reaches this only through checkPrerequisites,
 * which stamps the result onto SetupCheckResult. The gate, bootstrap and
 * pickers read those fields and must never recompute them from `tools`. It
 * lives in `shared` (not `main`) only so tests on both sides can run the same
 * policy over the recorded fixtures in testing/fixtures/first-run.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 * - Any "required" tool. No single tool blocks launch: a terminal pane needs
 *   none, and one provider is enough for agents. The probes can also be wrong
 *   (#495 A1: exotic shells, Finder PATH), so a hard block on a probe result
 *   is a lockout with a false-negative trigger.
 * - Login state. A found CLI may still be signed out; detecting that is a
 *   separate problem (#995 finding 7) and is out of scope here.
 */
export function deriveReadiness(
  tools: Record<SetupToolId, SetupToolStatus>,
): Pick<SetupCheckResult, 'usableProviders' | 'firstSessionKind'> {
  // A bundled provider counts: `found` is already true for it (the probe
  // sets found = bundled || system path). That is the whole point of #994:
  // the packaged app's OpenCode makes a clean Mac usable.
  const usableProviders = AGENT_PROVIDER_KINDS.filter(kind => tools[kind]?.found === true)
  return { usableProviders, firstSessionKind: firstSessionKindFor(usableProviders) }
}

/**
 * The first project's session kind.
 *
 * WHY the default provider first, then registry order, then a terminal:
 * - The default provider is what every other spawn path uses when nothing
 *   is chosen, so a machine that has it behaves exactly as before #995.
 * - Otherwise any usable provider beats a terminal, because agents are the
 *   product. Registry order (AGENT_PROVIDER_KINDS) is the one ordering every
 *   picker already shows, so the choice is predictable, not arbitrary.
 * - With no provider, a terminal is the only surface that needs nothing
 *   installed, and it is where a user runs the install commands the gate shows.
 */
export function firstSessionKindFor(
  usableProviders: readonly AgentProviderKind[],
): AgentProviderKind | 'terminal' {
  if (usableProviders.includes(DEFAULT_PROVIDER)) return DEFAULT_PROVIDER
  return usableProviders[0] ?? 'terminal'
}
