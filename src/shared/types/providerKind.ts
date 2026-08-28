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
export const AGENT_PROVIDER_KINDS = ['claude', 'codex', 'opencode'] as const

/** A provider that runs an actual agent (has transcripts, conditions, …). */
export type AgentProviderKind = (typeof AGENT_PROVIDER_KINDS)[number]

/**
 * A kind of pane the shell can host. Strict superset of AgentProviderKind, with
 * two members that are deliberately NOT agents:
 *
 *   'terminal'        a plain shell pane. Has a PTY, no agent transcript.
 *   'extension-view'  a contributed extension view rendered as a tile leaf.
 *                     Has NO backing process at all — no PTY, no agent — and is
 *                     reconstructed purely from SessionMeta.extensionViewId.
 *
 * Neither is an AgentProviderKind, so code that only makes sense for agents
 * (resume listing, prompt indexing, condition snapshots, composer drafts) cannot
 * be handed one by the type system.
 *
 * ── HOW TO TEST FOR "IS THIS AN AGENT" ──
 * Use `isAgentSessionKind`, never `kind !== 'terminal'`. The negative spelling
 * was correct only while 'terminal' was the ONLY non-agent kind; adding
 * 'extension-view' silently reclassified every extension pane as an agent at
 * ~30 call sites at once. See that function for the full account.
 */
export type SessionKind = AgentProviderKind | 'terminal' | 'extension-view'

/** All session kinds, runtime form. Kept derived so it never drifts. */
export const SESSION_KINDS = [...AGENT_PROVIDER_KINDS, 'terminal', 'extension-view'] as const

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

/** Narrow an untrusted string to a SessionKind (any pane kind, agent or not). */
export function isSessionKind(value: unknown): value is SessionKind {
  return typeof value === 'string' && (SESSION_KINDS as readonly string[]).includes(value)
}

/**
 * Does this pane run an agent — i.e. does it have a transcript, a composer,
 * conditions, a resumable provider session?
 *
 * ── WHY THIS EXISTS, AND WHY `kind !== 'terminal'` IS BANNED ──
 * For most of this codebase's history 'terminal' was the only non-agent kind, so
 * "is an agent" was spelled `kind !== 'terminal'` in about thirty places: pane
 * command `when` guards, the Dispatch pin filter, rehydrate's spawn options,
 * Reader Mode's session list, the activity modal, invalidation effects.
 *
 * Adding 'extension-view' to SessionKind reclassified every one of them at once,
 * and the compiler could not see it — the expression stayed perfectly valid and
 * silently changed meaning. Concretely, an extension pane became eligible for
 * "Copy Last Response" (which then calls getRuntime on a pane that has no
 * runtime), got pinned into Dispatch as an agent, was offered a composer it does
 * not have, and rendered a "Claude Code" provider label in its header.
 *
 * The positive spelling cannot fail that way: a new non-agent kind is simply not
 * in AGENT_PROVIDER_KINDS, so it is excluded by construction everywhere at once.
 *
 * ── WHY `undefined` COUNTS AS AN AGENT ──
 * Not a shortcut — it is the same back-compat truth DEFAULT_PROVIDER encodes.
 * `SessionMeta.kind` is optional because it postdates the workspace format, and
 * every session persisted before it existed genuinely was Claude. Every call site
 * this replaced already treated `undefined` as an agent (an absent kind is not
 * equal to 'terminal'), so preserving that here is what makes the substitution
 * behaviour-preserving for real sessions while fixing extension panes.
 */
export function isAgentSessionKind(value: SessionKind | undefined): boolean {
  return value === undefined || isAgentProviderKind(value)
}

/**
 * The provider used when a spawn/restore site has no explicit kind.
 *
 * WHY this exists as a named constant: before the provider plug-and-play
 * refactor (#394) the codebase had ~40 scattered `?? 'claude'` fallbacks —
 * in rehydrate, spawn actions, pane splits, undo-close, tile mounting and
 * more. Each was an invisible policy decision ("absent kind means Claude")
 * that no one could find, reconsider, or change in one place. They now all
 * route through this constant.
 *
 * Two DIFFERENT situations funnel here, and only one is really "default":
 *   1. Persisted workspace blobs from before `SessionMeta.kind` existed —
 *      those sessions genuinely were Claude, so this is back-compat truth.
 *   2. Convenience defaults for new spawns when the caller didn't say —
 *      this is product policy and may become a user setting later.
 * If those ever need to diverge, split this into two constants; do NOT
 * re-scatter inline literals.
 */
export const DEFAULT_PROVIDER: AgentProviderKind = 'claude'
