// Provider / session kind — the single source of truth.
//
// WHY this module exists (and is separate from session.ts):
//   "Which agent backends does Agent Code support, and which kinds of
//   pane can exist" was previously expressed as the bare string-union
//   `'claude' | 'codex' | 'terminal'` re-declared independently in
//   preload (`@preload/api/types`), main (`sessionManager`) and the
//   renderer (`workspace/types`), plus ad-hoc `'claude' | 'codex'`
//   unions scattered across MCP, transcript discovery, worktree
//   activity, feed types and the provider registries. Adding or
//   removing a provider meant grepping for every spelling and hoping
//   none were missed — there was no compiler-enforced checklist.
//
//   Provider identity is NOT only a session-metadata concern: it is
//   used by MCP orchestration, transcript discovery, worktree activity,
//   renderer feature code and both provider registries. So it earns its
//   own boundary-neutral module rather than living inside session.ts.
//
// WHY a `const` array plus a derived type instead of a hand-written
// union: the array is the ONE place a new provider is added. The type
// is derived from it, and `AGENT_PROVIDER_KINDS` doubles as the runtime
// iteration source for exhaustive registry checks (see the registries'
// `Record<AgentProviderKind, …>` typing and the parity test). Drift
// between "the type" and "the runtime list of providers" becomes
// impossible.

/**
 * The agent backends Agent Code can drive. This is the list to extend
 * when wiring a new provider (e.g. opencode) — but ONLY once the
 * provider is actually registered in registry.main.ts / registry.renderer.ts,
 * because the registries are typed `Record<AgentProviderKind, …>` and
 * will fail to compile until every kind has a config. That compile
 * error is the intended checklist.
 */
export const AGENT_PROVIDER_KINDS = ['claude', 'codex'] as const

/** A provider that runs an actual agent (has transcripts, conditions, …). */
export type AgentProviderKind = (typeof AGENT_PROVIDER_KINDS)[number]

/**
 * A kind of pane the shell can host. Superset of AgentProviderKind:
 * `'terminal'` is a plain shell pane with no agent transcript/conditions.
 * Terminal is deliberately NOT an AgentProviderKind so code that only
 * makes sense for agents (resume listing, prompt indexing, condition
 * snapshots) cannot accidentally be handed `'terminal'`.
 */
export type SessionKind = AgentProviderKind | 'terminal'

/** All session kinds, runtime form. Kept derived so it never drifts. */
export const SESSION_KINDS = [...AGENT_PROVIDER_KINDS, 'terminal'] as const

/**
 * Narrow an untrusted string (IPC arg, persisted metadata, MCP input)
 * to an AgentProviderKind. Use this at every boundary BEFORE indexing a
 * `Record<AgentProviderKind, …>` registry — TypeScript will not let you
 * index such a record with a bare `string`, and that is on purpose: an
 * unvalidated provider id is exactly how a typo or a stale persisted
 * value would otherwise crash deep inside a provider factory.
 */
export function isAgentProviderKind(value: unknown): value is AgentProviderKind {
  return typeof value === 'string' && (AGENT_PROVIDER_KINDS as readonly string[]).includes(value)
}

/** Narrow an untrusted string to a SessionKind (includes 'terminal'). */
export function isSessionKind(value: unknown): value is SessionKind {
  return typeof value === 'string' && (SESSION_KINDS as readonly string[]).includes(value)
}
