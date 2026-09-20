import type { AgentProviderKind } from '@shared/types/providerKind.js'

// External tools whose presence the setup gate inspects. Bundled
// helpers like mitmdump (#119) and tmux (#120) are deliberately NOT
// listed here — they ship inside Agent Code as runtime artifacts and
// have no user-actionable install story.
//
// mitmdump remains in the union temporarily for the follow-up
// cleanup PR that mirrors what #120 does for tmux; #119's
// implementation kept it visible as "Bundled" for one release while
// we proved the resolver works. Once that follow-up lands the union
// shrinks further.
// Provider tools derive from AGENT_PROVIDER_KINDS (#394 phase 2c-3):
// this union previously re-enumerated 'claude' | 'codex' by hand — a
// second provider list that had to be extended in lockstep with the
// real one. Registering a provider now automatically makes it a
// setup-gate tool; its metadata comes from
// @providers/registry.setup.ts.
export type SetupToolId =
  | 'brew'
  | 'git'
  | 'mitmdump'
  | AgentProviderKind

/**
 * Where a found tool comes from. 'bundled' = Agent Code ships this
 * helper inside the app and the user does not need to install it
 * separately; 'system' = it was discovered on PATH (Homebrew, manual
 * install, etc.). The renderer uses this to drop the install prompt
 * for bundled tools and label them clearly.
 */
export type SetupToolSource = 'bundled' | 'system'

export type SetupToolStatus = {
  id: SetupToolId
  label: string
  /**
   * An agent provider CLI rather than a helper tool.
   *
   * WHY this replaced `required` (#995): `required` meant "a missing binary
   * blocks app launch", and Claude Code and Codex were both required. A fresh
   * Mac therefore met a gate with no Continue button, even in the packaged app
   * where OpenCode ships bundled and works (testing/fixtures/first-run records
   * that wall). No single tool is a launch prerequisite any more: a terminal
   * pane needs none, and any ONE provider is enough for agents. The gate still
   * needs to tell providers from helpers, to show install commands and the
   * manual path override, and this is that distinction without the lockout.
   */
  provider: boolean
  found: boolean
  path: string | null
  installable: boolean
  source?: SetupToolSource
  skipped?: boolean
  detail?: string
  /** A copyable install command for a provider CLI (registry.setup.ts). */
  installCommand?: string
  /** The provider's own install documentation. */
  docsUrl?: string
}

export type SetupCheckResult = {
  checkedAt: number
  tools: Record<SetupToolId, SetupToolStatus>
  /**
   * Providers whose CLI resolved, in AGENT_PROVIDER_KINDS order. Computed once,
   * in src/main/setup/readiness.ts. The gate, the fresh-install bootstrap and
   * the provider pickers all read it; none of them re-derives it from `tools`.
   */
  usableProviders: AgentProviderKind[]
  /**
   * What a fresh install opens its first project with: the default provider
   * when it is usable, otherwise the first usable one, otherwise a terminal.
   */
  firstSessionKind: AgentProviderKind | 'terminal'
  /**
   * The user has already answered "continue without a provider" on this
   * machine. The panel stops opening by itself for that reason; it is still
   * one command away. Without this, a terminal-only user met the modal on
   * every launch and in every new window.
   */
  noProvidersAcknowledged: boolean
}

// Targets the SetupGate's "Install via Homebrew" button can hand to
// the main process. tmux was removed when its bundled binary became
// the only supported source (#120); mitmproxy is on the same track
// in a follow-up. The follow-up will collapse this to `never` and
// retire the `setup:install` IPC entirely.
export type SetupInstallTarget = 'mitmproxy'

export type SetupInstallResult = {
  ok: boolean
  target: SetupInstallTarget
  output: string
  check: SetupCheckResult
}

// Result of the manual path override (#495 A1). The escape hatch exists
// because automatic resolution is a probe, and a probe can be wrong —
// a false negative must never be able to lock the user out of the app.
// ok:false carries a human-readable reason for inline display; ok:true
// returns a fresh check so the gate can re-render (and unlock Continue)
// without a second round-trip.
export type SetupSetToolPathResult =
  | { ok: true; check: SetupCheckResult }
  | { ok: false; reason: string }
